import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderStreamChunk,
  ProviderStreamResult,
  ProviderThinkingBlock
} from '../../shared/providerRuntime'
import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'
import { previewToolCallArguments } from './toolCallPreview'
import { normalizeCompletedToolInput } from '../../shared/toolCalls'

type FetchImplementation = typeof fetch
type Emit = (chunk: ProviderStreamChunk) => void

interface AnthropicBlock {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicStreamEvent {
  type?: string
  index: number
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  content_block?: AnthropicBlock
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
  error?: { message?: string; type?: string }
}

function headers(
  instance: ProviderInstance,
  request?: ProviderChatRequest
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': instance.apiKey || '',
    'anthropic-version': '2023-06-01',
    ...(request?.thinkingEnabled && request.tools?.length
      ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
      : {})
  }
}

function imageBlock(image: string): Record<string, unknown> {
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match?.[1] || 'image/png',
      data: match?.[2] || image
    }
  }
}

function messageContent(message: ProviderChatMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const thinking of message.thinking_blocks || []) blocks.push({ ...thinking })
  if (message.content) blocks.push({ type: 'text', text: message.content })
  for (const image of message.images || []) blocks.push(imageBlock(image))
  for (const call of message.tool_calls || []) {
    let input = call.function.arguments || {}
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input) as Record<string, unknown>
      } catch {
        input = { raw: input }
      }
    }
    blocks.push({
      type: 'tool_use',
      id: call.id || `tool_${crypto.randomUUID()}`,
      name: call.function.name,
      input
    })
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }]
}

export function toAnthropicMessages(messages: ProviderChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content || '')
    .filter(Boolean)
    .join('\n\n')
  const converted: Array<{
    role: 'user' | 'assistant'
    content: Array<Record<string, unknown>>
  }> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content =
      message.role === 'tool'
        ? [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id || '',
              content: message.content || ''
            }
          ]
        : messageContent(message)
    const previous = converted.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else converted.push({ role, content })
  }
  return { ...(system ? { system } : {}), messages: converted }
}

function anthropicTools(tools: unknown[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined
  return tools.map((raw) => {
    const tool = raw as Record<string, unknown>
    const fn =
      tool.function && typeof tool.function === 'object'
        ? (tool.function as Record<string, unknown>)
        : tool
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} }
    }
  })
}

function thinkingConfig(request: ProviderChatRequest): Record<string, unknown> | undefined {
  if (!request.thinkingEnabled) return undefined
  const model = request.target.model.toLowerCase()
  if (/(?:opus-4-[678]|sonnet-4-6|sonnet-5|mythos|fable)/.test(model)) {
    return { type: 'adaptive', display: 'summarized' }
  }
  const maxTokens = request.maxOutputTokens || 16_000
  const requestedBudget = request.reasoningTokens || 10_000
  const budgetTokens = Math.min(requestedBudget, maxTokens - 1)
  if (budgetTokens < 1_024) return undefined
  return {
    type: 'enabled',
    budget_tokens: budgetTokens,
    display: 'summarized'
  }
}

function body(request: ProviderChatRequest, stream: boolean): Record<string, unknown> {
  const converted = toAnthropicMessages(request.messages)
  const thinking = thinkingConfig(request)
  return {
    model: request.target.model,
    max_tokens: request.maxOutputTokens || 8_192,
    messages: converted.messages,
    system: converted.system,
    tools: anthropicTools(request.tools),
    stream,
    ...(request.temperature !== undefined && !request.thinkingEnabled
      ? { temperature: request.temperature }
      : {}),
    ...(thinking ? { thinking } : {})
  }
}

async function responseError(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`
  try {
    const data = (await response.json()) as { error?: { message?: string }; message?: string }
    return data.error?.message || data.message || fallback
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

export async function streamAnthropicChat(
  instance: ProviderInstance,
  request: ProviderChatRequest,
  emit: Emit,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/messages`, {
      method: 'POST',
      headers: headers(instance, request),
      signal,
      body: JSON.stringify(body(request, true))
    })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        retryAfter: retryAfter(response),
        error: await responseError(response)
      }
    }
    const reader = response.body?.getReader()
    if (!reader) return { ok: false, error: 'Anthropic returned no response body' }
    const decoder = new TextDecoder()
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
    const toolPreviewSignatures = new Map<number, string>()
    const thinkingBlocks = new Map<number, ProviderThinkingBlock>()
    let buffer = ''
    let promptTokens = 0
    let completionTokens = 0
    let finishReason = 'end_turn'
    let generationId: string | undefined
    let streamError: string | undefined

    const consume = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      try {
        const event = JSON.parse(trimmed.slice(5).trim()) as AnthropicStreamEvent
        switch (event.type) {
          case 'message_start':
            generationId = event.message?.id
            promptTokens = event.message?.usage?.input_tokens || 0
            completionTokens = event.message?.usage?.output_tokens || 0
            break
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              const tool = {
                id: event.content_block.id || '',
                name: event.content_block.name || '',
                json: Object.keys(event.content_block.input || {}).length
                  ? JSON.stringify(event.content_block.input)
                  : ''
              }
              toolBlocks.set(event.index, tool)
              const previewArguments = previewToolCallArguments(tool.json)
              toolPreviewSignatures.set(
                event.index,
                `${tool.name}\n${JSON.stringify(previewArguments)}`
              )
              emit({
                message: {
                  tool_calls: [
                    {
                      id: tool.id,
                      index: event.index,
                      type: 'function',
                      function: { name: tool.name, arguments: previewArguments }
                    }
                  ]
                },
                done: false
              })
            } else if (event.content_block?.type === 'thinking') {
              thinkingBlocks.set(event.index, {
                type: 'thinking',
                thinking: event.content_block.thinking || '',
                signature: event.content_block.signature || ''
              })
            } else if (event.content_block?.type === 'redacted_thinking') {
              thinkingBlocks.set(event.index, {
                type: 'redacted_thinking',
                data: event.content_block.data || ''
              })
            } else if (event.content_block?.type === 'text' && event.content_block.text) {
              emit({ message: { content: event.content_block.text }, done: false })
            }
            break
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              emit({ message: { content: event.delta.text }, done: false })
            } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
              emit({ message: { thinking: event.delta.thinking }, done: false })
              const block = thinkingBlocks.get(event.index)
              if (block?.type === 'thinking') block.thinking += event.delta.thinking
            } else if (event.delta?.type === 'signature_delta' && event.delta.signature) {
              const block = thinkingBlocks.get(event.index)
              if (block?.type === 'thinking') block.signature += event.delta.signature
            } else if (event.delta?.type === 'input_json_delta') {
              const tool = toolBlocks.get(event.index)
              if (tool) {
                tool.json += event.delta.partial_json || ''
                const previewArguments = previewToolCallArguments(tool.json)
                const previewSignature = `${tool.name}\n${JSON.stringify(previewArguments)}`
                if (toolPreviewSignatures.get(event.index) !== previewSignature) {
                  toolPreviewSignatures.set(event.index, previewSignature)
                  emit({
                    message: {
                      tool_calls: [
                        {
                          id: tool.id,
                          index: event.index,
                          type: 'function',
                          function: { name: tool.name, arguments: previewArguments }
                        }
                      ]
                    },
                    done: false
                  })
                }
              }
            }
            break
          case 'content_block_stop': {
            const thinking = thinkingBlocks.get(event.index)
            if (thinking) {
              emit({ message: { thinking_blocks: [thinking] }, done: false })
              thinkingBlocks.delete(event.index)
            }
            const tool = toolBlocks.get(event.index)
            if (tool) {
              const normalized = normalizeCompletedToolInput(tool.json)
              const args =
                typeof normalized.arguments === 'string'
                  ? (JSON.parse(normalized.arguments) as Record<string, unknown>)
                  : normalized.arguments
              emit({
                message: {
                  tool_calls: [
                    {
                      id: tool.id,
                      index: event.index,
                      type: 'function',
                      function: { name: tool.name, arguments: args }
                    }
                  ]
                },
                done: false
              })
              toolBlocks.delete(event.index)
              toolPreviewSignatures.delete(event.index)
            }
            break
          }
          case 'message_delta':
            finishReason = event.delta?.stop_reason || finishReason
            completionTokens = event.usage?.output_tokens || completionTokens
            break
          case 'error':
            streamError = event.error?.message || event.error?.type || 'Anthropic stream failed'
            break
        }
      } catch {
        // Ignore unknown future SSE events as required by Anthropic's versioning policy.
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
    emit({
      done: true,
      done_reason: finishReason,
      prompt_eval_count: promptTokens,
      eval_count: completionTokens
    })
    return { ok: true, generationId }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: 'aborted' }
    return { ok: false, error: error instanceof Error ? error.message : 'Anthropic stream failed' }
  }
}

function normalizeBlocks(blocks: AnthropicBlock[]): ProviderCompletionResult['data'] {
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name || '', arguments: block.input || {} }
    }))
  const thinkingBlocks = blocks
    .filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking')
    .map(
      (block): ProviderThinkingBlock =>
        block.type === 'redacted_thinking'
          ? { type: 'redacted_thinking', data: block.data || '' }
          : {
              type: 'thinking',
              thinking: block.thinking || '',
              signature: block.signature || ''
            }
    )
  return {
    message: {
      role: 'assistant',
      content: blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join(''),
      thinking:
        blocks
          .filter((block) => block.type === 'thinking')
          .map((block) => block.thinking || '')
          .join('') || undefined,
      thinking_blocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      tool_calls: toolCalls.length ? toolCalls : null
    },
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    finishReason: 'end_turn'
  }
}

export async function completeAnthropicChat(
  instance: ProviderInstance,
  request: ProviderChatRequest,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<ProviderCompletionResult> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/messages`, {
      method: 'POST',
      headers: headers(instance, request),
      signal,
      body: JSON.stringify(body(request, false))
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await responseError(response) }
    }
    const data = (await response.json()) as {
      content?: AnthropicBlock[]
      usage?: { input_tokens?: number; output_tokens?: number }
      stop_reason?: string
    }
    const normalized = normalizeBlocks(data.content || [])!
    normalized.promptTokens = data.usage?.input_tokens || 0
    normalized.completionTokens = data.usage?.output_tokens || 0
    normalized.finishReason = data.stop_reason || 'end_turn'
    return { ok: true, data: normalized }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Anthropic completion failed'
    }
  }
}

export async function discoverAnthropicModels(
  instance: ProviderInstance,
  fetchImpl: FetchImplementation = fetch
): Promise<{ ok: boolean; models?: ProviderInstanceModel[]; error?: string; status?: number }> {
  try {
    const response = await fetchImpl(`${instance.baseUrl}/models?limit=100`, {
      headers: headers(instance)
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: await responseError(response) }
    }
    const data = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string }>
    }
    const previous = new Map(instance.models.map((model) => [model.id, model]))
    const models = (data.data || [])
      .map((model) => ({
        ...previous.get(model.id),
        id: model.id,
        name: previous.get(model.id)?.name || model.display_name || model.id,
        enabled: previous.get(model.id)?.enabled ?? false,
        contextLength: previous.get(model.id)?.contextLength || 200_000,
        supportsVision: true
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ok: true, models }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Anthropic discovery failed'
    }
  }
}
