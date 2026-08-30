import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderStreamChunk,
  ProviderStreamResult
} from '../../shared/providerRuntime'
import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'

type FetchImplementation = typeof fetch
type Emit = (chunk: ProviderStreamChunk) => void

function headers(instance: ProviderInstance): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(instance.apiKey ? { Authorization: `Bearer ${instance.apiKey}` } : {})
  }
}

function thinkValue(model: string, enabled: boolean): boolean | 'low' | 'medium' {
  return model.toLowerCase().includes('gpt-oss') ? (enabled ? 'medium' : 'low') : enabled
}

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
    think: thinkValue(request.target.model, request.thinkingEnabled ?? true),
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
  try {
    const response = await fetchImpl(`${instance.baseUrl}/api/chat`, {
      method: 'POST',
      headers: headers(instance),
      signal,
      body: JSON.stringify(body(request, true))
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await errorMessage(response) }
    }
    const reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Provider returned no response body' }
    const decoder = new TextDecoder()
    let buffer = ''
    let streamError: string | undefined
    const consume = (line: string): void => {
      if (!line.trim()) return
      try {
        const chunk = JSON.parse(line) as ProviderStreamChunk
        if (chunk.error) streamError = chunk.error
        emit(chunk)
      } catch {
        // Wait for a complete newline-delimited JSON record.
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      lines.forEach(consume)
    }
    buffer += decoder.decode()
    if (buffer) consume(buffer)
    if (streamError) {
      emit({ done: true, done_reason: 'error', error: streamError })
      return { ok: false, error: streamError }
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: 'aborted' }
    return { ok: false, error: error instanceof Error ? error.message : 'Ollama stream failed' }
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
    return { ok: false, error: error instanceof Error ? error.message : 'Ollama completion failed' }
  }
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
    const previous = new Map(instance.models.map((model) => [model.id, model]))
    const models = (data.models || [])
      .map((model) => model.name || model.model || '')
      .filter(Boolean)
      .map((id) => ({
        ...previous.get(id),
        id,
        name: previous.get(id)?.name || id,
        enabled: previous.get(id)?.enabled ?? false
      }))
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
  try {
    const response = await fetchImpl(`${instance.baseUrl}/api/show`, {
      method: 'POST',
      headers: headers(instance),
      body: JSON.stringify({ model })
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { model_info?: Record<string, unknown> }
    const key = Object.keys(data.model_info || {}).find((candidate) =>
      candidate.includes('context_length')
    )
    return key && typeof data.model_info?.[key] === 'number'
      ? (data.model_info[key] as number)
      : undefined
  } catch {
    return undefined
  }
}
