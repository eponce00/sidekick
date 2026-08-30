import type {
  ProviderCompletionResult,
  ProviderStreamChunk,
  ProviderStreamResult
} from '../../shared/providerRuntime'
import {
  completeOpenAICompatibleChat,
  normalizeOpenAICompatibleEndpoint
} from './openAICompatibleClient'
import { previewToolCallArguments } from './toolCallPreview'
import {
  incompleteToolInputArguments,
  looksLikeIncompleteToolInputError,
  normalizeCompletedToolInput
} from '../../shared/toolCalls'

type FetchImplementation = typeof fetch
type Emit = (chunk: ProviderStreamChunk) => void

interface OpenAIStreamEvent {
  id?: string
  error?: { message?: string; type?: string }
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

async function responseError(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`
  try {
    const raw = (await response.json()) as {
      error?: string | { message?: string }
      message?: string
    }
    if (typeof raw.error === 'string') return raw.error
    return raw.error?.message || raw.message || fallback
  } catch {
    return fallback
  }
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
  emit: Emit,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  try {
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
        error: await responseError(response),
        status: response.status,
        retryAfter: retryAfter(response)
      }
    }
    const reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Provider returned no response body' }

    const decoder = new TextDecoder()
    const thinkRouter = createThinkTagRouter(emit)
    const toolCalls = new Map<
      number,
      { id: string; type: string; function: { name: string; arguments: string } }
    >()
    const toolPreviewSignatures = new Map<number, string>()
    let buffer = ''
    let promptTokens = 0
    let cachedPromptTokens: number | undefined
    let completionTokens = 0
    let predictedPerSecond: number | undefined
    let finishReason = 'stop'
    let generationId: string | undefined
    let streamError: string | undefined
    let gotContent = false
    let gotThinking = false

    const consumeLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      try {
        const json = JSON.parse(data) as OpenAIStreamEvent
        if (json.error) {
          streamError = json.error.message || json.error.type || 'Provider stream failed'
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
            const index = raw.index ?? 0
            const existing = toolCalls.get(index) || {
              id: raw.id || `call_${Date.now()}_${index}`,
              type: raw.type || 'function',
              function: { name: '', arguments: '' }
            }
            if (raw.id) existing.id = raw.id
            if (raw.type) existing.type = raw.type
            if (raw.function?.name) existing.function.name += raw.function.name
            if (raw.function?.arguments) existing.function.arguments += raw.function.arguments
            toolCalls.set(index, existing)

            const previewArguments = previewToolCallArguments(existing.function.arguments)
            const previewSignature = `${existing.function.name}\n${JSON.stringify(previewArguments)}`
            if (existing.function.name && toolPreviewSignatures.get(index) !== previewSignature) {
              toolPreviewSignatures.set(index, previewSignature)
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
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      } catch {
        // Providers may split arbitrary network chunks, but never a completed SSE data line.
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      lines.forEach(consumeLine)
    }
    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)
    thinkRouter.finish()

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
        return { ok: true, generationId }
      }
      emit({ done: true, done_reason: 'error', error: streamError })
      return { ok: false, error: streamError }
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
      prompt_eval_count: promptTokens,
      ...(cachedPromptTokens === undefined ? {} : { cached_prompt_tokens: cachedPromptTokens }),
      eval_count: completionTokens,
      ...(predictedPerSecond ? { predicted_per_second: predictedPerSecond } : {})
    })
    return { ok: true, generationId }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: 'aborted' }
    return { ok: false, error: error instanceof Error ? error.message : 'Provider stream failed' }
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
