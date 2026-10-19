import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderStreamChunk,
  ProviderStreamResult
} from '../../shared/providerRuntime'
import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'

import { cancelProviderStreamReader, releaseProviderStreamReader } from './providerStreamReader'
import { nearestEffort, requestReasoningLevel, type ReasoningLevel } from '../../shared/reasoning'
import { providerConnectionFailureMessage } from '../../shared/providerErrors'
import { applyProviderModelOverrides, hasReportedMetadata, positiveInteger } from './modelCatalog'

type FetchImplementation = typeof fetch
type Emit = (chunk: ProviderStreamChunk) => void

function headers(instance: ProviderInstance): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(instance.apiKey ? { Authorization: `Bearer ${instance.apiKey}` } : {})
  }
}

/** Ollama's `think`: on or off, or a level for gpt-oss, which cannot stop reasoning. */
function thinkValue(model: string, level: ReasoningLevel | undefined): ThinkValue | undefined {
  if (level === 'auto') return undefined
  if (model.toLowerCase().includes('gpt-oss')) {
    if (level === 'off') return 'low'
    return nearestEffort(level ?? 'medium', ['low', 'medium', 'high'] as const)
  }
  return level !== 'off'
}

type ThinkValue = boolean | 'low' | 'medium' | 'high'

function ollamaImagePayload(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s)
  return match?.[1] || dataUrl
}

function messageImages(message: ProviderChatMessage): Array<{
  data: string
  label?: string
}> {
  const images = (message.images || []).map((dataUrl) => ({ data: ollamaImagePayload(dataUrl) }))
  for (const attachment of message.media || []) {
    if (attachment.source.type !== 'data_url') {
      throw new Error('Provider media must be materialized before Ollama serialization')
    }
    images.push({
      data: ollamaImagePayload(attachment.source.dataUrl),
      ...((attachment.description || attachment.name) && {
        label: attachment.description || attachment.name
      })
    })
  }
  return images
}

/** Ollama expects raw base64 image payloads, not data URLs. */
export function toOllamaMessages(messages: ProviderChatMessage[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  let pendingToolImages: Array<{ data: string; label?: string; toolCallId: string }> = []
  const flushToolImages = (): void => {
    if (!pendingToolImages.length) return
    converted.push({
      role: 'user',
      content: pendingToolImages
        .map(
          (image) =>
            `Visual output from tool call ${image.toolCallId}${image.label ? `: ${image.label}` : ''}`
        )
        .join('\n'),
      images: pendingToolImages.map(({ data }) => data)
    })
    pendingToolImages = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flushToolImages()
    const images = messageImages(message)
    const { images: _legacyImages, media: _media, ...base } = message
    if (message.role === 'tool') {
      converted.push(base)
      pendingToolImages.push(
        ...images.map((image) => ({
          ...image,
          toolCallId: message.tool_call_id || 'unknown'
        }))
      )
      continue
    }
    converted.push({
      ...base,
      ...(images.length ? { images: images.map(({ data }) => data) } : {})
    })
  }
  flushToolImages()
  return converted
}

function body(request: ProviderChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.target.model,
    messages: toOllamaMessages(request.messages),
    tools: request.tools?.length ? request.tools : undefined,
    stream,
    keep_alive: '30m',
    think: thinkValue(request.target.model, requestReasoningLevel(request) ?? 'on'),
    options: {
      ...(request.target.contextLength ? { num_ctx: request.target.contextLength } : {}),
      ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
    }
  }
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`
  try {
    const raw = await response.text()
    const data = JSON.parse(raw) as { error?: string; message?: string }
    return data.error || data.message || fallback
  } catch {
    return fallback
  }
}

export async function streamOllamaChat(
  instance: ProviderInstance,
  request: ProviderChatRequest,
  emit: Emit,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelReader = (): void => cancelProviderStreamReader(reader)
  try {
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    const response = await fetchImpl(`${instance.baseUrl}/api/chat`, {
      method: 'POST',
      headers: headers(instance),
      signal,
      body: JSON.stringify(body(request, true))
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await errorMessage(response) }
    }
    reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Provider returned no response body' }
    signal?.addEventListener('abort', cancelReader, { once: true })
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    const decoder = new TextDecoder()
    let buffer = ''
    let streamError: string | undefined
    let terminal = false
    const consume = (line: string): void => {
      if (signal?.aborted || terminal || streamError) return
      if (!line.trim()) return
      let chunk: ProviderStreamChunk
      try {
        chunk = JSON.parse(line) as ProviderStreamChunk
      } catch {
        // Ignore malformed records, not exceptions from the subscriber.
        return
      }
      if (!chunk || typeof chunk !== 'object') return
      if (chunk.error) streamError = chunk.error
      terminal = chunk.done === true
      emit(chunk)
    }
    while (!terminal && !streamError && !signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted) return { ok: false, error: 'aborted' }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      lines.forEach(consume)
    }
    buffer += decoder.decode()
    if (buffer) consume(buffer)
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    if (streamError) {
      if (!terminal) emit({ done: true, done_reason: 'error', error: streamError })
      return { ok: false, error: streamError }
    }
    if (!terminal) return { ok: false, error: 'Ollama stream ended before its terminal event' }
    return { ok: true }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
      return { ok: false, error: 'aborted' }
    return {
      ok: false,
      error:
        providerConnectionFailureMessage(error, instance.baseUrl) ??
        (error instanceof Error ? error.message : 'Ollama stream failed')
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    releaseProviderStreamReader(reader)
  }
}

export async function completeOllamaChat(
  instance: ProviderInstance,
  request: ProviderChatRequest,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderCompletionResult> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/api/chat`, {
      method: 'POST',
      headers: headers(instance),
      signal,
      body: JSON.stringify(body(request, false))
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await errorMessage(response) }
    }
    const data = (await response.json()) as {
      message?: {
        role?: string
        content?: string
        thinking?: string
        tool_calls?: import('../../shared/providerRuntime').ProviderToolCall[]
      }
      prompt_eval_count?: number
      eval_count?: number
      done_reason?: string
    }
    return {
      ok: true,
      data: {
        message: {
          role: data.message?.role || 'assistant',
          content: data.message?.content || '',
          thinking: data.message?.thinking,
          tool_calls: data.message?.tool_calls
        },
        promptTokens: Number(data.prompt_eval_count) || 0,
        completionTokens: Number(data.eval_count) || 0,
        reasoningTokens: 0,
        finishReason: typeof data.done_reason === 'string' ? data.done_reason : 'stop'
      }
    }
  } catch (error) {
    return {
      ok: false,
      error:
        providerConnectionFailureMessage(error, instance.baseUrl) ??
        (error instanceof Error ? error.message : 'Ollama completion failed')
    }
  }
}

interface OllamaShowResponse {
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

async function showOllamaModel(
  instance: ProviderInstance,
  model: string,
  fetchImpl: FetchImplementation
): Promise<OllamaShowResponse | undefined> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/api/show`, {
      method: 'POST',
      headers: headers(instance),
      body: JSON.stringify({ model })
    })
    if (!response.ok) return undefined
    return (await response.json()) as OllamaShowResponse
  } catch {
    return undefined
  }
}

/** The trained context window, which `model_info` keys by architecture, as `llama.context_length`. */
function contextFromModelInfo(info: Record<string, unknown> | undefined): number | undefined {
  const key = Object.keys(info || {}).find((candidate) => candidate.endsWith('context_length'))
  return key ? positiveInteger(info?.[key]) : undefined
}

/**
 * One installed model, with what `/api/show` says it can do. Null for an embedding model, which
 * cannot hold a chat.
 */
export function normalizeOllamaModel(
  id: string,
  show: OllamaShowResponse | undefined
): ProviderInstanceModel | null {
  const capabilities = Array.isArray(show?.capabilities) ? show.capabilities : undefined
  if (capabilities?.includes('embedding') && !capabilities.includes('completion')) return null
  const normalized: ProviderInstanceModel = {
    id,
    name: id,
    enabled: false,
    contextLength: contextFromModelInfo(show?.model_info),
    supportsTools: capabilities ? capabilities.includes('tools') : undefined,
    supportsVision: capabilities ? capabilities.includes('vision') : undefined,
    supportsReasoning: capabilities ? capabilities.includes('thinking') : undefined
  }
  return { ...normalized, metadataSource: hasReportedMetadata(normalized) ? 'provider' : 'unknown' }
}

export async function discoverOllamaModels(
  instance: ProviderInstance,
  fetchImpl: FetchImplementation = fetch
): Promise<{ ok: boolean; models?: ProviderInstanceModel[]; error?: string; status?: number }> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/api/tags`, { headers: headers(instance) })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await errorMessage(response) }
    }
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> }
    const ids = Array.from(
      new Set((data.models || []).map((model) => model.name || model.model || '').filter(Boolean))
    )
    // A few at a time: each lookup reads the model file's header on the server.
    const shown: Array<OllamaShowResponse | undefined> = new Array(ids.length)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const index = next++
          shown[index] = await showOllamaModel(instance, ids[index], fetchImpl)
        }
      })
    )
    const configured = new Map(instance.models.map((model) => [model.id, model]))
    const models = ids
      .map((id, index) => normalizeOllamaModel(id, shown[index]))
      .filter((model): model is ProviderInstanceModel => model !== null)
      .map((model) => applyProviderModelOverrides(model, configured.get(model.id)))
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ok: true, models }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Ollama discovery failed' }
  }
}

export async function resolveOllamaContext(
  instance: ProviderInstance,
  model: string,
  fetchImpl: FetchImplementation = fetch
): Promise<number | undefined> {
  return contextFromModelInfo((await showOllamaModel(instance, model, fetchImpl))?.model_info)
}
