import type {
  ProviderCompletionResult,
  ProviderStreamChunk,
  ProviderStreamResult
} from '../../shared/providerRuntime'
import {
  completeOpenAICompatibleChat,
  normalizeOpenAICompatibleEndpoint,
  requestFailureMessage
} from './openAICompatibleClient'
import { ToolCallPreviews } from './toolCallPreview'
import { cancelProviderStreamReader, releaseProviderStreamReader } from './providerStreamReader'
import {
  incompleteToolInputArguments,
  looksLikeIncompleteToolInputError,
  normalizeCompletedToolInput
} from '../../shared/toolCalls'

type FetchImplementation = typeof fetch
type Emit = (chunk: ProviderStreamChunk) => void

interface OpenAIStreamEvent {
  id?: string
  model?: string
  error?: { message?: string; type?: string; code?: string | number }
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  timings?: { predicted_per_second?: number }
  choices?: Array<{
    finish_reason?: string
    delta?: Record<string, unknown> & {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

/** The provider's own name for an error, such as OpenAI's `insufficient_quota`; never a status. */
function errorCode(error: { code?: unknown; type?: unknown }): string | undefined {
  return [error.code, error.type].find(
    (value): value is string => typeof value === 'string' && !/^\d+$/.test(value)
  )
}

async function responseError(response: Response): Promise<{ error: string; code?: string }> {
  const fallback = `HTTP ${response.status}`
  try {
    const raw = (await response.json()) as {
      error?: string | { message?: string; code?: unknown; type?: unknown }
      message?: string
    }
    if (typeof raw.error === 'string') return { error: raw.error }
    const code = raw.error ? errorCode(raw.error) : undefined
    return { error: raw.error?.message || raw.message || fallback, ...(code ? { code } : {}) }
  } catch {
    return { error: fallback }
  }
}

/** LiteLLM and vLLM name the HTTP status of an error they report inside a stream as its code. */
function streamErrorStatus(code: unknown): number | undefined {
  const status =
    typeof code === 'number' ? code : typeof code === 'string' && /^\d{3}$/.test(code) ? +code : 0
  return status >= 400 && status <= 599 ? status : undefined
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After')
  if (!raw) return undefined
  const seconds = Number.parseInt(raw, 10)
  if (Number.isFinite(seconds)) return seconds
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000))
    : undefined
}

function isWholeJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function reasoningText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.reasoning === 'string') return record.reasoning
  if (typeof record.reasoning_content === 'string') return record.reasoning_content
  if (!Array.isArray(record.reasoning_details)) return ''
  return record.reasoning_details
    .map((detail) => {
      if (!detail || typeof detail !== 'object') return ''
      const item = detail as Record<string, unknown>
      return typeof item.text === 'string'
        ? item.text
        : typeof item.summary === 'string'
          ? item.summary
          : ''
    })
    .join('')
}

function suffixPrefixLength(value: string, marker: string): number {
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length--) {
    if (marker.startsWith(value.slice(-length))) return length
  }
  return 0
}

export function createThinkTagRouter(emit: Emit): {
  push: (content: string) => void
  finish: () => void
} {
  let buffer = ''
  let thinking = false
  const route = (final: boolean): void => {
    while (buffer) {
      const marker = thinking ? '</think>' : '<think>'
      const index = buffer.indexOf(marker)
      if (index >= 0) {
        const content = buffer.slice(0, index)
        if (content) emit({ message: thinking ? { thinking: content } : { content }, done: false })
        buffer = buffer.slice(index + marker.length)
        thinking = !thinking
        continue
      }
      const retained = final ? 0 : suffixPrefixLength(buffer, marker)
      const content = retained ? buffer.slice(0, -retained) : buffer
      if (content) emit({ message: thinking ? { thinking: content } : { content }, done: false })
      buffer = retained ? buffer.slice(-retained) : ''
      break
    }
  }
  return {
    push(content) {
      buffer += content
      route(false)
    },
    finish() {
      route(true)
    }
  }
}

export async function streamOpenAICompatibleChat(
  endpoint: string,
  requestBody: Record<string, unknown>,
  headers: Record<string, string>,
  onChunk: Emit,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  const emit: Emit = (chunk) => {
    signal?.throwIfAborted()
    onChunk(chunk)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelReader = (): void => cancelProviderStreamReader(reader)
  try {
    signal?.throwIfAborted()
    const response = await fetchImpl(
      `${normalizeOpenAICompatibleEndpoint(endpoint)}/chat/completions`,
      {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          ...requestBody,
          stream: true,
          stream_options: { include_usage: true }
        })
      }
    )
    if (!response.ok) {
      return {
        ok: false,
        ...(await responseError(response)),
        status: response.status,
        retryAfter: retryAfter(response)
      }
    }
    reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Provider returned no response body' }
    signal?.addEventListener('abort', cancelReader, { once: true })
    signal?.throwIfAborted()

    const decoder = new TextDecoder()
    const thinkRouter = createThinkTagRouter(emit)
    const toolCalls = new Map<
      number,
      { id: string; type: string; function: { name: string; arguments: string } }
    >()
    const toolPreviews = new ToolCallPreviews()
    const closedToolCalls = new Set<number>()
    // The id the server gave each call, to tell a delta that starts a call from one that goes on.
    const sourceToolCallIds = new Map<number, string>()
    let lastToolCallIndex: number | undefined
    const toolCallIndex = (raw: { index?: number; id?: string }): number => {
      if (typeof raw.index === 'number') return raw.index
      // Without an index, a delta with a new id starts the next call; any other goes on the last.
      if (
        lastToolCallIndex !== undefined &&
        (!raw.id || raw.id === sourceToolCallIds.get(lastToolCallIndex))
      )
        return lastToolCallIndex
      return toolCalls.size ? Math.max(...toolCalls.keys()) + 1 : 0
    }
    // A call is finished once the model has started a later one and its arguments are whole. A
    // server may send every call's header before any arguments, so a later call alone is not enough.
    const closeFinishedToolCalls = (): void => {
      const latest = Math.max(...toolCalls.keys())
      const finished = [...toolCalls.entries()].filter(
        ([index, call]) =>
          index < latest &&
          !closedToolCalls.has(index) &&
          call.function.name &&
          isWholeJsonObject(call.function.arguments)
      )
      if (!finished.length) return
      for (const [index] of finished) closedToolCalls.add(index)
      emit({
        message: {
          closed_tool_calls: finished.map(([index, call]) => ({
            ...call,
            index,
            function: { ...call.function }
          }))
        },
        done: false
      })
    }
    let buffer = ''
    let promptTokens = 0
    let cachedPromptTokens: number | undefined
    let completionTokens = 0
    let predictedPerSecond: number | undefined
    let finishReason = 'stop'
    let gotFinishReason = false
    let generationId: string | undefined
    let reportedModel: string | undefined
    let streamError: string | undefined
    let streamErrorStatusCode: number | undefined
    let streamErrorName: string | undefined
    let gotContent = false
    let gotThinking = false
    let streamDone = false

    const consumeLine = (line: string): void => {
      signal?.throwIfAborted()
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data) return
      if (data === '[DONE]') {
        streamDone = true
        return
      }
      let json: OpenAIStreamEvent
      try {
        json = JSON.parse(data) as OpenAIStreamEvent
      } catch {
        // Retain tolerance for malformed SSE JSON only. Consumer/storage failures
        // are real turn failures and must escape to the outer result handler.
        return
      }
      if (typeof json.model === 'string') reportedModel = json.model
      if (json.error) {
        streamError = json.error.message || json.error.type || 'Provider stream failed'
        streamErrorStatusCode = streamErrorStatus(json.error.code)
        streamErrorName = errorCode(json.error)
        return
      }
      if (typeof json.id === 'string' && !generationId) generationId = json.id
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens || promptTokens
        completionTokens = json.usage.completion_tokens || completionTokens
        if (typeof json.usage.prompt_tokens_details?.cached_tokens === 'number') {
          cachedPromptTokens = json.usage.prompt_tokens_details.cached_tokens
        }
      }
      if (typeof json.timings?.predicted_per_second === 'number') {
        predictedPerSecond = json.timings.predicted_per_second
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta || {}
      const reasoning = reasoningText(delta)
      if (reasoning) {
        gotThinking = true
        emit({ message: { thinking: reasoning }, done: false })
      }
      if (typeof delta.content === 'string' && delta.content) {
        gotContent = true
        thinkRouter.push(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const index = toolCallIndex(raw)
          lastToolCallIndex = index
          const existing = toolCalls.get(index) || {
            id: raw.id || `call_${Date.now()}_${index}`,
            type: raw.type || 'function',
            function: { name: '', arguments: '' }
          }
          if (raw.id) {
            existing.id = raw.id
            sourceToolCallIds.set(index, raw.id)
          }
          if (raw.type) existing.type = raw.type
          // Most servers send the name once; some repeat it whole in every delta.
          const name = raw.function?.name
          if (name) {
            existing.function.name = name.startsWith(existing.function.name)
              ? name
              : existing.function.name + name
          }
          if (raw.function?.arguments) existing.function.arguments += raw.function.arguments
          toolCalls.set(index, existing)

          const previewArguments = toolPreviews.next(
            index,
            existing.function.name,
            existing.function.arguments
          )
          if (previewArguments) {
            emit({
              message: {
                tool_calls: [
                  {
                    id: existing.id,
                    index,
                    type: existing.type,
                    function: { name: existing.function.name, arguments: previewArguments }
                  }
                ]
              },
              done: false
            })
          }
        }
        closeFinishedToolCalls()
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason
        gotFinishReason = true
      }
    }

    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        consumeLine(line)
        if (streamDone || streamError) break
      }
      if (streamDone || streamError) break
    }
    if (!streamDone && !streamError) {
      buffer += decoder.decode()
      if (buffer) consumeLine(buffer)
    }
    signal?.throwIfAborted()
    thinkRouter.finish()
    signal?.throwIfAborted()

    // EOF alone is not a completed generation. Do not promote partial previews
    // into executable tools or launch the empty-stream compatibility fallback.
    // An explicit finish reason may precede usage, so it never ends reading early.
    if (!streamDone && !gotFinishReason && !streamError) {
      streamError = 'Provider stream ended before completion'
    }

    if (streamError) {
      const incompleteCalls = [...toolCalls.entries()]
        .filter(([, call]) => call.function.name)
        .sort(([left], [right]) => left - right)
      if (incompleteCalls.length > 0 && looksLikeIncompleteToolInputError(streamError)) {
        emit({
          message: {
            tool_calls: incompleteCalls.map(([index, call]) => ({
              ...call,
              index,
              function: {
                name: call.function.name,
                arguments: incompleteToolInputArguments()
              }
            }))
          },
          done: false
        })
        emit({
          done: true,
          done_reason: 'tool_calls',
          prompt_eval_count: promptTokens,
          ...(cachedPromptTokens === undefined ? {} : { cached_prompt_tokens: cachedPromptTokens }),
          eval_count: completionTokens,
          ...(predictedPerSecond ? { predicted_per_second: predictedPerSecond } : {})
        })
        signal?.throwIfAborted()
        return { ok: true, generationId }
      }
      emit({ done: true, done_reason: 'error', error: streamError })
      return {
        ok: false,
        error: streamError,
        ...(streamErrorStatusCode ? { status: streamErrorStatusCode } : {}),
        ...(streamErrorName ? { code: streamErrorName } : {})
      }
    }
    const requestedTools = Array.isArray(requestBody.tools) && requestBody.tools.length > 0
    if (requestedTools && toolCalls.size === 0 && !gotContent && !gotThinking) {
      const fallback = await completeOpenAICompatibleChat(
        endpoint,
        requestBody,
        headers,
        fetchImpl,
        signal
      )
      if (!fallback.ok || !fallback.data) {
        return {
          ok: false,
          error: fallback.error || 'Provider returned an empty stream and fallback failed',
          status: fallback.status
        }
      }
      if (fallback.data) {
        if (fallback.data.message.thinking) {
          emit({ message: { thinking: fallback.data.message.thinking }, done: false })
        }
        if (fallback.data.message.content) {
          emit({ message: { content: fallback.data.message.content }, done: false })
        }
        if (fallback.data.message.tool_calls?.length) {
          emit({ message: { tool_calls: fallback.data.message.tool_calls }, done: false })
        }
        promptTokens = fallback.data.promptTokens || promptTokens
        cachedPromptTokens = fallback.data.cachedPromptTokens ?? cachedPromptTokens
        completionTokens = fallback.data.completionTokens || completionTokens
        finishReason = fallback.data.finishReason || finishReason
      }
    }
    if (toolCalls.size) {
      emit({
        message: {
          tool_calls: [...toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([index, call]) => ({
              ...call,
              index,
              function: {
                name: call.function.name,
                arguments: normalizeCompletedToolInput(call.function.arguments).arguments
              }
            }))
        },
        done: false
      })
    }
    emit({
      done: true,
      done_reason: finishReason,
      ...(reportedModel ? { reported_model: reportedModel } : {}),
      prompt_eval_count: promptTokens,
      ...(cachedPromptTokens === undefined ? {} : { cached_prompt_tokens: cachedPromptTokens }),
      eval_count: completionTokens,
      ...(predictedPerSecond ? { predicted_per_second: predictedPerSecond } : {})
    })
    signal?.throwIfAborted()
    return { ok: true, generationId }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: 'aborted' }
    return { ok: false, error: requestFailureMessage(error, endpoint) }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    releaseProviderStreamReader(reader)
  }
}

export async function completeOpenAIChat(
  endpoint: string,
  requestBody: Record<string, unknown>,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderCompletionResult> {
  return completeOpenAICompatibleChat(endpoint, requestBody, headers, fetchImpl, signal)
}
