import { nearestEffort, requestReasoningLevel, type ReasoningLevel } from '../../shared/reasoning'
import {
  providerDefinitionForInstance,
  providerKindForInstance
} from '../../shared/providerRegistry'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  MAX_TOOL_RESULT_MEDIA_BYTES,
  normalizeToolResultMedia,
  type ToolResultMediaAttachment
} from '../../shared/agentRuntime'
import type {
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderContextResult,
  ProviderDiscoveryRequest,
  ProviderDiscoveryResult,
  ProviderGenerationStatsResult,
  ProviderHealthChangedEvent,
  ProviderStreamChunk,
  ProviderStreamResult
} from '../../shared/providerRuntime'
import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'
import { offlineProviderHealth, onlineProviderHealth } from '../../shared/providerHealth'
import { PRODUCT_IDENTITY, PRODUCT_REPOSITORY_URL } from '../../shared/productIdentity'
import { abortablePromise } from '../services/abortablePromise'
import { credentialRedactor } from '../services/credentialRedaction'
import { completeOpenAIChat, streamOpenAICompatibleChat } from './openAIStreamingClient'
import { fetchOpenAICompatibleModels, openAICompatibleHeaders } from './openAICompatibleClient'
import {
  discoverLiteLLMModels,
  normalizeOpenAIModelMetadata,
  openAIModelContextLength
} from './liteLLMClient'
import {
  applyProviderModelOverrides,
  fetchLMStudioModelDetails,
  isChatModelMode,
  lmStudioModelChats,
  normalizeOpenRouterModel,
  openRouterModelChats,
  withLMStudioDetails,
  type OpenRouterCatalogModel
} from './modelCatalog'
import {
  completeOllamaChat,
  discoverOllamaModels,
  resolveOllamaContext,
  streamOllamaChat
} from './ollamaClient'
import {
  completeAnthropicChat,
  discoverAnthropicModels,
  streamAnthropicChat
} from './anthropicClient'
import {
  requireProviderApiKey,
  resolveProviderDraft,
  resolveProviderInstance,
  resolveProviderInstanceById
} from './providerResolver'

type Emit = (chunk: ProviderStreamChunk) => void
type ProviderHealthPublisher = (change: ProviderHealthChangedEvent) => void

let publishProviderHealth: ProviderHealthPublisher = () => undefined

export function setProviderHealthPublisher(publisher: ProviderHealthPublisher): void {
  publishProviderHealth = publisher
}

async function observeProviderRequest<T extends { ok: boolean; error?: string }>(
  instance: ProviderInstance,
  request: ProviderChatRequest,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>
): Promise<T> {
  try {
    const result = await execute()
    if (!signal?.aborted) {
      publishProviderHealth({
        providerInstanceId: instance.id,
        health: result.ok
          ? onlineProviderHealth()
          : offlineProviderHealth(result.error || 'Provider request failed'),
        purpose: request.purpose
      })
    }
    return result
  } catch (error) {
    if (!signal?.aborted) {
      publishProviderHealth({
        providerInstanceId: instance.id,
        health: offlineProviderHealth(error),
        purpose: request.purpose
      })
    }
    throw error
  }
}

type MaterializedToolMedia = ToolResultMediaAttachment & {
  source: Extract<ToolResultMediaAttachment['source'], { type: 'data_url' }>
}

/**
 * Local vision gateways commonly cap a request at two images. The budget is
 * global: composer attachments and tool/browser media are serialized into the
 * same provider prompt and must not be bounded independently.
 */
export const MAX_PROVIDER_IMAGE_ATTACHMENTS = 2

function withProviderImageBudget(messages: ProviderChatMessage[]): ProviderChatMessage[] {
  let remaining = MAX_PROVIDER_IMAGE_ATTACHMENTS
  let changed = false
  const selected = [...messages]
  const keptImageIndexes = new Set<number>()
  const latestAttachedImageIndex = messages.findLastIndex((message) =>
    Boolean(message.images?.length)
  )

  const keepImages = (index: number): void => {
    const message = selected[index]
    const images = message.images ?? []
    if (!images.length) return
    // The first images in a user-authored attachment set carry the user's explicit
    // ordering, so preserve those when the provider budget is smaller than the set.
    const kept = images.slice(0, remaining)
    remaining -= kept.length
    if (kept.length) keptImageIndexes.add(index)
    if (kept.length !== images.length) {
      changed = true
      selected[index] = { ...message, images: kept.length ? kept : undefined }
    }
  }

  // Preserve the newest user-supplied visual before allocating space to automatic
  // browser captures. This keeps the screenshot that motivated the task in view.
  if (latestAttachedImageIndex >= 0) keepImages(latestAttachedImageIndex)

  // Then retain only the freshest visual tool states. The durable event ledger is
  // left untouched; this selection exists solely at the provider I/O boundary.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = selected[index]
    const media = message.media ?? []
    if (!media.length) continue
    const keepCount = Math.min(remaining, media.length)
    const kept = keepCount ? media.slice(media.length - keepCount) : []
    remaining -= kept.length
    if (kept.length !== media.length) {
      changed = true
      selected[index] = { ...message, media: kept.length ? kept : undefined }
    }
  }

  // Use any remaining capacity for older explicit attachments, newest first.
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    if (index !== latestAttachedImageIndex) keepImages(index)
  }

  // Clear older attachment sets that could not fit after the global budget was
  // allocated. They remain available in chat history and the durable database.
  for (let index = 0; index < messages.length; index++) {
    if (!selected[index].images?.length || keptImageIndexes.has(index)) continue
    changed = true
    selected[index] = { ...selected[index], images: undefined }
  }

  return changed ? selected : messages
}

function materializedMessageImages(message: ProviderChatMessage): Array<{
  dataUrl: string
  name?: string
  description?: string
}> {
  const images: Array<{ dataUrl: string; name?: string; description?: string }> = (
    message.images || []
  ).map((dataUrl) => ({ dataUrl }))
  for (const attachment of message.media || []) {
    if (attachment.type !== 'image') continue
    if (attachment.source.type !== 'data_url') {
      throw new Error('Provider media must be materialized before serialization')
    }
    images.push({
      dataUrl: attachment.source.dataUrl,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.description ? { description: attachment.description } : {})
    })
  }
  const seen = new Set<string>()
  return images.filter(({ dataUrl }) => {
    if (seen.has(dataUrl)) return false
    seen.add(dataUrl)
    return true
  })
}

async function materializeAttachment(
  attachment: ToolResultMediaAttachment
): Promise<MaterializedToolMedia | null> {
  if (attachment.source.type === 'data_url') return attachment as MaterializedToolMedia
  const path = attachment.source.path
  if (!isAbsolute(path)) throw new Error('Tool result media file references must be absolute')
  let metadata: Awaited<ReturnType<typeof stat>>
  try {
    metadata = await stat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Browser screenshots are intentionally retention-bounded. A conversation can
    // outlive its visual artifact, so historical media must degrade to text rather
    // than making every later continuation fail.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  if (!metadata.isFile()) throw new Error(`Tool result media is not a file: ${path}`)
  if (metadata.size > MAX_TOOL_RESULT_MEDIA_BYTES) {
    throw new Error(`Tool result media exceeds ${MAX_TOOL_RESULT_MEDIA_BYTES} bytes: ${path}`)
  }
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_TOOL_RESULT_MEDIA_BYTES) {
    throw new Error(`Tool result media exceeds ${MAX_TOOL_RESULT_MEDIA_BYTES} bytes: ${path}`)
  }
  return {
    ...attachment,
    source: {
      type: 'data_url',
      dataUrl: `data:${attachment.mimeType};base64,${bytes.toString('base64')}`
    }
  }
}

/**
 * The last place a stored credential value could leave for a model provider. Earlier redaction
 * covers tool output; this catches anything else, such as a value the user pasted into a message.
 * Thinking blocks are left alone: providers sign them, and only the model writes them.
 */
function redactProviderMessage(message: ProviderChatMessage): ProviderChatMessage {
  const content = message.content ? credentialRedactor.redact(message.content) : message.content
  const toolCalls = message.tool_calls
    ? credentialRedactor.redactDeep(message.tool_calls)
    : message.tool_calls
  return content === message.content && toolCalls === message.tool_calls
    ? message
    : { ...message, content, tool_calls: toolCalls }
}

/** Resolve durable file references only at the provider boundary, and redact stored values. */
export async function materializeProviderRequestMedia(
  request: ProviderChatRequest
): Promise<ProviderChatRequest> {
  const prepared = await materializeMedia(request)
  if (!credentialRedactor.active) return prepared
  const messages = prepared.messages.map(redactProviderMessage)
  return messages.some((message, index) => message !== prepared.messages[index])
    ? { ...prepared, messages }
    : prepared
}

async function materializeMedia(request: ProviderChatRequest): Promise<ProviderChatRequest> {
  const selectedMessages = withProviderImageBudget(request.messages)
  let changed = selectedMessages !== request.messages
  const messages = await Promise.all(
    selectedMessages.map(async (message) => {
      if (!message.media?.length) return message
      const media = normalizeToolResultMedia(message.media) || []
      const resolved = await Promise.all(media.map(materializeAttachment))
      const materialized = resolved.filter(
        (attachment): attachment is MaterializedToolMedia => attachment !== null
      )
      const unavailable = resolved.length - materialized.length
      changed ||= materialized.some(
        (attachment, index) => attachment.source !== media[index]?.source
      )
      changed ||= unavailable > 0
      return {
        ...message,
        ...(materialized.length ? { media: materialized } : { media: undefined }),
        ...(unavailable
          ? {
              content: `${message.content || ''}${message.content ? '\n' : ''}[${unavailable} historical visual artifact${unavailable === 1 ? '' : 's'} no longer available.]`
            }
          : {})
      }
    })
  )
  return changed ? { ...request, messages } : request
}

export function toOpenAICompatibleMessages(
  messages: ProviderChatRequest['messages']
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []
  let pendingToolMedia: Array<Record<string, unknown>> = []
  const flushToolMedia = (): void => {
    if (!pendingToolMedia.length) return
    converted.push({ role: 'user', content: pendingToolMedia })
    pendingToolMedia = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flushToolMedia()
    const toolCalls = message.tool_calls?.map((toolCall) => ({
      ...toolCall,
      type: toolCall.type || 'function',
      function: {
        ...toolCall.function,
        arguments:
          typeof toolCall.function.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments || {})
      }
    }))
    const images = materializedMessageImages(message)
    if (message.role === 'tool') {
      converted.push({
        role: message.role,
        content: message.content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
      })
      if (images.length) {
        pendingToolMedia.push({
          type: 'text',
          text: `Visual output from tool call ${message.tool_call_id || 'unknown'}:`
        })
        for (const image of images) {
          if (image.description || image.name) {
            pendingToolMedia.push({
              type: 'text',
              text: image.description || image.name || 'Tool image'
            })
          }
          pendingToolMedia.push({ type: 'image_url', image_url: { url: image.dataUrl } })
        }
      }
      continue
    }
    if (!images.length) {
      converted.push({
        role: message.role,
        content: message.content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
      })
      continue
    }
    converted.push({
      role: message.role,
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...images.map(({ dataUrl }) => ({ type: 'image_url', image_url: { url: dataUrl } }))
      ],
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
    })
  }
  flushToolMedia()
  return converted
}

function openAIHeaders(instance: ProviderInstance): Record<string, string> {
  const headers = openAICompatibleHeaders(instance.apiKey)
  if (providerKindForInstance(instance) === 'openrouter') {
    headers['HTTP-Referer'] = PRODUCT_REPOSITORY_URL
    headers['X-Title'] = `${PRODUCT_IDENTITY.productName} Desktop Agent`
  }
  return headers
}

const REASONING_FIELDS = ['reasoning', 'reasoning_effort', 'chat_template_kwargs'] as const

/** Each OpenAI-compatible server's own way of carrying a reasoning level. */
function openAIReasoningFields(request: ProviderChatRequest): Record<string, unknown> {
  const level = requestReasoningLevel(request)
  if (!level || level === 'auto') return {}
  const kind = request.target.providerKind
  if (kind === 'openrouter') {
    if (request.reasoningTokens && level !== 'off')
      return { reasoning: { max_tokens: request.reasoningTokens } }
    return {
      reasoning: {
        effort:
          level === 'off'
            ? 'none'
            : nearestEffort(level, ['minimal', 'low', 'medium', 'high', 'xhigh'] as const)
      }
    }
  }
  // llama.cpp and vLLM switch thinking through the model's chat template.
  const template =
    kind === 'llamacpp' || kind === 'openai-compatible'
      ? { chat_template_kwargs: { enable_thinking: level !== 'off' } }
      : {}
  if (kind === 'llamacpp') return template
  if (level === 'off') return { reasoning_effort: 'none', ...template }
  if (level === 'on') return template
  return {
    reasoning_effort:
      kind === 'litellm'
        ? nearestEffort(level, ['minimal', 'low', 'medium', 'high', 'xhigh'] as const)
        : nearestEffort(level, ['low', 'medium', 'high'] as const),
    ...template
  }
}

export function openAIRequest(request: ProviderChatRequest): Record<string, unknown> {
  return {
    model: request.target.model,
    messages: toOpenAICompatibleMessages(request.messages),
    tools: request.tools?.length ? request.tools : undefined,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    ...openAIReasoningFields(request)
  }
}

// What a server says when it will not take a reasoning parameter: a model that must reason, one
// that cannot, or a server that rejects fields it does not know.
const REASONING_REJECTED =
  /reasoning|effort|chat_template|enable_thinking|thinking|unrecognized request argument|unsupported parameter|unknown (?:parameter|field)|extra (?:inputs|fields)/i

/** Whether to retry a request without its reasoning settings, which then use the model default. */
export function reasoningWasRejected(result: { ok: boolean; error?: string }): boolean {
  return !result.ok && REASONING_REJECTED.test(result.error || '')
}

export async function executeOpenAICompatibleWithReasoningFallback<
  T extends { ok: boolean; error?: string }
>(
  request: ProviderChatRequest,
  execute: (body: Record<string, unknown>) => Promise<T>
): Promise<T> {
  const body = openAIRequest(request)
  const result = await execute(body)
  const carried = REASONING_FIELDS.filter((field) => field in body)
  if (!carried.length || !reasoningWasRejected(result)) return result
  // A level is never worth a failed reply: ask again with the model's own default.
  const retryBody = { ...body }
  for (const field of carried) delete retryBody[field]
  return execute(retryBody)
}

/** Ollama and Anthropic carry the level in their own requests; a rejected one retries without. */
export async function withReasoningRetry<T extends { ok: boolean; error?: string }>(
  request: ProviderChatRequest,
  run: (request: ProviderChatRequest) => Promise<T>
): Promise<T> {
  const result = await run(request)
  const level = requestReasoningLevel(request)
  if (!level || level === 'auto' || !reasoningWasRejected(result)) return result
  // Anthropic rejecting an effort level can still think adaptively.
  const fallback: ReasoningLevel =
    request.target.providerKind === 'anthropic' && level !== 'off' && level !== 'on' ? 'on' : 'auto'
  return run({ ...request, reasoningLevel: fallback, thinkingEnabled: undefined })
}

export async function streamProviderChat(
  request: ProviderChatRequest,
  emit: Emit,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  const instance = resolveProviderInstance(request.target)
  const definition = providerDefinitionForInstance(instance)
  const preparedRequest = await materializeProviderRequestMedia(request)
  return observeProviderRequest(instance, preparedRequest, signal, () => {
    if (definition.capabilities.credentials === 'required') requireProviderApiKey(instance)
    if (definition.protocol === 'ollama') {
      return withReasoningRetry(preparedRequest, (attempt) =>
        streamOllamaChat(instance, attempt, emit, fetch, signal)
      )
    }
    if (definition.protocol === 'anthropic') {
      return withReasoningRetry(preparedRequest, (attempt) =>
        streamAnthropicChat(instance, attempt, emit, fetch, signal)
      )
    }
    return executeOpenAICompatibleWithReasoningFallback(preparedRequest, (body) =>
      streamOpenAICompatibleChat(
        instance.baseUrl,
        body,
        openAIHeaders(instance),
        emit,
        fetch,
        signal
      )
    )
  })
}

export async function completeProviderChat(
  request: ProviderChatRequest,
  signal?: AbortSignal
): Promise<ProviderCompletionResult> {
  const instance = resolveProviderInstance(request.target)
  const definition = providerDefinitionForInstance(instance)
  const preparedRequest = await materializeProviderRequestMedia(request)
  return observeProviderRequest(instance, preparedRequest, signal, () => {
    if (definition.capabilities.credentials === 'required') requireProviderApiKey(instance)
    if (definition.protocol === 'ollama') {
      return withReasoningRetry(preparedRequest, (attempt) =>
        completeOllamaChat(instance, attempt, fetch, signal)
      )
    }
    if (definition.protocol === 'anthropic') {
      return withReasoningRetry(preparedRequest, (attempt) =>
        completeAnthropicChat(instance, attempt, fetch, signal)
      )
    }
    return executeOpenAICompatibleWithReasoningFallback(preparedRequest, (body) =>
      completeOpenAIChat(instance.baseUrl, body, openAIHeaders(instance), fetch, signal)
    )
  })
}

async function discoverOpenAIModels(instance: ProviderInstance): Promise<ProviderDiscoveryResult> {
  const kind = providerKindForInstance(instance)
  if (kind === 'litellm') {
    const result = await discoverLiteLLMModels(instance, openAIHeaders(instance))
    return result.ok && result.data
      ? { ok: true, models: result.data.models }
      : { ok: false, error: result.error, status: result.status }
  }
  const headers = openAIHeaders(instance)
  const result = await fetchOpenAICompatibleModels(instance.baseUrl, headers)
  if (!result.ok || !result.data) return result
  const configured = (id: string): ProviderInstanceModel | undefined =>
    instance.models.find((model) => model.id === id)
  if (kind === 'openrouter') {
    const models = (result.data.data as OpenRouterCatalogModel[])
      .filter(openRouterModelChats)
      .map((model) =>
        applyProviderModelOverrides(normalizeOpenRouterModel(model), configured(model.id))
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ok: true, models }
  }
  const lmStudio =
    providerDefinitionForInstance(instance).capabilities.context === 'lmstudio-native'
      ? await fetchLMStudioModelDetails(instance.baseUrl, headers)
      : undefined
  const models = result.data.data
    .filter((model) => isChatModelMode(model.mode ?? model.model_info?.mode))
    .filter((model) => !lmStudio || lmStudioModelChats(lmStudio.get(model.id)))
    .map((model) =>
      applyProviderModelOverrides(
        withLMStudioDetails(normalizeOpenAIModelMetadata(model), lmStudio?.get(model.id)),
        configured(model.id)
      )
    )
    .sort((left, right) => left.id.localeCompare(right.id))
  return { ok: true, models }
}

function discoveryInstance(request: ProviderDiscoveryRequest): ProviderInstance {
  if (request.draft) return resolveProviderDraft(request.draft)
  if (request.providerInstanceId) return resolveProviderInstanceById(request.providerInstanceId)
  throw new Error('Provider discovery requires an instance')
}

export async function discoverProviderModels(
  request: ProviderDiscoveryRequest
): Promise<ProviderDiscoveryResult> {
  try {
    const instance = discoveryInstance(request)
    const definition = providerDefinitionForInstance(instance)
    if (definition.capabilities.credentials === 'required') requireProviderApiKey(instance)
    if (definition.capabilities.discovery === 'manual') {
      const health = await discoverOpenAIModels(instance)
      return health.ok ? { ok: true, models: instance.models } : health
    }
    if (definition.protocol === 'ollama') return discoverOllamaModels(instance)
    if (definition.protocol === 'anthropic') return discoverAnthropicModels(instance)
    return discoverOpenAIModels(instance)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Provider discovery failed'
    }
  }
}

async function resolveOpenAIContext(
  instance: ProviderInstance,
  model: string,
  signal?: AbortSignal
): Promise<number | undefined> {
  signal?.throwIfAborted()
  // Nested catalog adapters may try optional endpoints after a late response.
  // Guard each actual fetch, not just the outer discovery await.
  const contextFetch: typeof fetch = async (url, options) => {
    signal?.throwIfAborted()
    return fetch(url, { ...options, signal })
  }
  const definition = providerDefinitionForInstance(instance)
  if (definition.capabilities.context === 'lmstudio-native') {
    try {
      const root = instance.baseUrl.replace(/\/v1$/, '')
      const response = await contextFetch(`${root}/api/v0/models/${encodeURIComponent(model)}`, {
        headers: openAIHeaders(instance),
        signal
      })
      if (response.ok) {
        const data = (await response.json()) as { max_context_length?: number }
        if (data.max_context_length) return data.max_context_length
      }
    } catch {
      signal?.throwIfAborted()
      // Fall through to standard model metadata.
    }
  }
  try {
    signal?.throwIfAborted()
    if (definition.capabilities.context === 'litellm-model-metadata') {
      const result = await discoverLiteLLMModels(
        instance,
        openAIHeaders(instance),
        contextFetch,
        signal
      )
      signal?.throwIfAborted()
      const match = result.data?.models.find((candidate) => candidate.id === model)
      if (match?.contextLength) return match.contextLength
    }
    const result = await fetchOpenAICompatibleModels(
      instance.baseUrl,
      openAIHeaders(instance),
      contextFetch,
      signal
    )
    signal?.throwIfAborted()
    const match = result.data?.data.find((candidate) => candidate.id === model)
    const resolved = match ? openAIModelContextLength(match) : undefined
    if (resolved) return resolved
  } catch {
    signal?.throwIfAborted()
    // Fall through to llama.cpp server props.
  }
  if (definition.capabilities.context === 'llamacpp-server') {
    try {
      const response = await contextFetch(`${instance.baseUrl.replace(/\/v1$/, '')}/props`, {
        headers: openAIHeaders(instance),
        signal
      })
      if (response.ok) {
        const data = (await response.json()) as {
          default_generation_settings?: { n_ctx?: number }
          n_ctx?: number
          n_ctx_train?: number
        }
        return data.default_generation_settings?.n_ctx || data.n_ctx || data.n_ctx_train
      }
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }
  return undefined
}

export async function resolveProviderContext(
  target: ProviderChatRequest['target'],
  signal?: AbortSignal
): Promise<ProviderContextResult> {
  signal?.throwIfAborted()
  if (target.contextLength) {
    return {
      ok: true,
      contextLength: target.contextLength,
      reliable: true,
      source: 'configured'
    }
  }
  try {
    const instance = resolveProviderInstance(target, false)
    const definition = providerDefinitionForInstance(instance)
    let contextLength: number | undefined
    if (definition.protocol === 'ollama') {
      const discovery = resolveOllamaContext(instance, target.model, (url, options) =>
        fetch(url, { ...options, signal })
      )
      contextLength = signal ? await abortablePromise(discovery, signal) : await discovery
    } else if (definition.protocol === 'anthropic') {
      contextLength =
        instance.models.find((model) => model.id === target.model)?.contextLength || 200_000
    } else {
      const discovery = resolveOpenAIContext(instance, target.model, signal)
      contextLength = signal ? await abortablePromise(discovery, signal) : await discovery
    }
    signal?.throwIfAborted()
    if (contextLength) {
      return { ok: true, contextLength, reliable: true, source: 'provider' }
    }
    return { ok: true, contextLength: 32_768, reliable: false, source: 'fallback' }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      ok: false,
      contextLength: 32_768,
      reliable: false,
      source: 'fallback',
      error: error instanceof Error ? error.message : 'Context discovery failed'
    }
  }
}

export async function getProviderGenerationStats(
  target: ProviderChatRequest['target'],
  generationId: string
): Promise<ProviderGenerationStatsResult> {
  try {
    const instance = resolveProviderInstance(target, false)
    if (providerKindForInstance(instance) !== 'openrouter') {
      return { ok: false, error: 'Generation stats are not supported by this provider' }
    }
    const response = await fetch(
      `${instance.baseUrl}/generation?id=${encodeURIComponent(generationId)}`,
      { headers: openAIHeaders(instance) }
    )
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const result = (await response.json()) as { data?: ProviderGenerationStatsResult['data'] }
    return { ok: true, data: result.data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Stats request failed' }
  }
}
