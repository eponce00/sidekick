import {
  providerDefinitionForInstance,
  providerKindForInstance
} from '../../shared/providerRegistry'
import type {
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
import type { ProviderInstance } from '../../shared/settings'
import { offlineProviderHealth, onlineProviderHealth } from '../../shared/providerHealth'
import { PRODUCT_IDENTITY, PRODUCT_REPOSITORY_URL } from '../../shared/productIdentity'
import { completeOpenAIChat, streamOpenAICompatibleChat } from './openAIStreamingClient'
import { fetchOpenAICompatibleModels, openAICompatibleHeaders } from './openAICompatibleClient'
import {
  applyProviderModelOverrides,
  discoverLiteLLMModels,
  normalizeOpenAIModelMetadata,
  openAIModelContextLength
} from './liteLLMClient'
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

interface OpenRouterCatalogModel {
  id: string
  name?: string
  context_length?: number
  architecture?: { modality?: string }
  pricing?: { prompt?: string | number; completion?: string | number }
}

export function toOpenAICompatibleMessages(
  messages: ProviderChatRequest['messages']
): Array<Record<string, unknown>> {
  return messages.map((message) => {
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
    if (!message.images?.length) {
      return {
        role: message.role,
        content: message.content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
      }
    }
    return {
      role: message.role,
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.images.map((url) => ({ type: 'image_url', image_url: { url } }))
      ],
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
    }
  })
}

function openAIHeaders(instance: ProviderInstance): Record<string, string> {
  const headers = openAICompatibleHeaders(instance.apiKey)
  if (providerKindForInstance(instance) === 'openrouter') {
    headers['HTTP-Referer'] = PRODUCT_REPOSITORY_URL
    headers['X-Title'] = `${PRODUCT_IDENTITY.productName} Desktop Agent`
  }
  return headers
}

export function openAIRequest(request: ProviderChatRequest): Record<string, unknown> {
  const openRouter = request.target.providerKind === 'openrouter'
  return {
    model: request.target.model,
    messages: toOpenAICompatibleMessages(request.messages),
    tools: request.tools?.length ? request.tools : undefined,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    ...(openRouter
      ? {
          reasoning: request.reasoningTokens
            ? { max_tokens: request.reasoningTokens }
            : { effort: request.thinkingEnabled ? 'medium' : 'none' }
        }
      : request.thinkingEnabled === false
        ? { reasoning_effort: 'none' }
        : {})
  }
}

export async function executeOpenAICompatibleWithReasoningFallback<
  T extends { ok: boolean; error?: string }
>(
  request: ProviderChatRequest,
  execute: (body: Record<string, unknown>) => Promise<T>
): Promise<T> {
  const body = openAIRequest(request)
  const result = await execute(body)
  const disabledReasoning =
    body.reasoning &&
    typeof body.reasoning === 'object' &&
    (body.reasoning as Record<string, unknown>).effort === 'none'
  if (
    result.ok ||
    request.target.providerKind !== 'openrouter' ||
    !disabledReasoning ||
    !/reasoning is (?:mandatory|required).+cannot be disabled/i.test(result.error || '')
  ) {
    return result
  }
  const retryBody = { ...body }
  delete retryBody.reasoning
  return execute(retryBody)
}

export async function streamProviderChat(
  request: ProviderChatRequest,
  emit: Emit,
  signal?: AbortSignal
): Promise<ProviderStreamResult> {
  const instance = resolveProviderInstance(request.target)
  const definition = providerDefinitionForInstance(instance)
  return observeProviderRequest(instance, request, signal, () => {
    if (definition.capabilities.credentials === 'required') requireProviderApiKey(instance)
    if (definition.protocol === 'ollama') {
      return streamOllamaChat(instance, request, emit, fetch, signal)
    }
    if (definition.protocol === 'anthropic') {
      return streamAnthropicChat(instance, request, emit, fetch, signal)
    }
    return executeOpenAICompatibleWithReasoningFallback(request, (body) =>
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
  return observeProviderRequest(instance, request, signal, () => {
    if (definition.capabilities.credentials === 'required') requireProviderApiKey(instance)
    if (definition.protocol === 'ollama') {
      return completeOllamaChat(instance, request, fetch, signal)
    }
    if (definition.protocol === 'anthropic') {
      return completeAnthropicChat(instance, request, fetch, signal)
    }
    return executeOpenAICompatibleWithReasoningFallback(request, (body) =>
      completeOpenAIChat(instance.baseUrl, body, openAIHeaders(instance), fetch, signal)
    )
  })
}

function configuredState(instance: ProviderInstance, id: string): boolean {
  return instance.models.find((model) => model.id === id)?.enabled ?? false
}

async function discoverOpenAIModels(instance: ProviderInstance): Promise<ProviderDiscoveryResult> {
  const kind = providerKindForInstance(instance)
  if (kind === 'litellm') {
    const result = await discoverLiteLLMModels(instance, openAIHeaders(instance))
    return result.ok && result.data
      ? { ok: true, models: result.data.models }
      : { ok: false, error: result.error, status: result.status }
  }
  const result = await fetchOpenAICompatibleModels(instance.baseUrl, openAIHeaders(instance))
  if (!result.ok || !result.data) return result
  if (kind === 'openrouter') {
    const models = (result.data.data as OpenRouterCatalogModel[])
      .map((model) =>
        applyProviderModelOverrides(
          {
            id: model.id,
            name: model.name || model.id,
            enabled: configuredState(instance, model.id),
            contextLength: model.context_length,
            supportsVision:
              typeof model.architecture?.modality === 'string' &&
              model.architecture.modality.includes('image'),
            pricing: model.pricing
              ? {
                  prompt: Number(model.pricing.prompt),
                  completion: Number(model.pricing.completion)
                }
              : undefined
          },
          instance.models.find((configured) => configured.id === model.id)
        )
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    return { ok: true, models }
  }
  const models = result.data.data
    .map((model) =>
      applyProviderModelOverrides(
        normalizeOpenAIModelMetadata(model),
        instance.models.find((configured) => configured.id === model.id)
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
  model: string
): Promise<number | undefined> {
  const definition = providerDefinitionForInstance(instance)
  if (definition.capabilities.context === 'lmstudio-native') {
    try {
      const root = instance.baseUrl.replace(/\/v1$/, '')
      const response = await fetch(`${root}/api/v0/models/${encodeURIComponent(model)}`, {
        headers: openAIHeaders(instance)
      })
      if (response.ok) {
        const data = (await response.json()) as { max_context_length?: number }
        if (data.max_context_length) return data.max_context_length
      }
    } catch {
      // Fall through to standard model metadata.
    }
  }
  try {
    if (definition.capabilities.context === 'litellm-model-metadata') {
      const result = await discoverLiteLLMModels(instance, openAIHeaders(instance))
      const match = result.data?.models.find((candidate) => candidate.id === model)
      if (match?.contextLength) return match.contextLength
    }
    const result = await fetchOpenAICompatibleModels(instance.baseUrl, openAIHeaders(instance))
    const match = result.data?.data.find((candidate) => candidate.id === model)
    const resolved = match ? openAIModelContextLength(match) : undefined
    if (resolved) return resolved
  } catch {
    // Fall through to llama.cpp server props.
  }
  if (definition.capabilities.context === 'llamacpp-server') {
    try {
      const response = await fetch(`${instance.baseUrl.replace(/\/v1$/, '')}/props`, {
        headers: openAIHeaders(instance)
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
      return undefined
    }
  }
  return undefined
}

export async function resolveProviderContext(
  target: ProviderChatRequest['target']
): Promise<ProviderContextResult> {
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
      contextLength = await resolveOllamaContext(instance, target.model)
    } else if (definition.protocol === 'anthropic') {
      contextLength =
        instance.models.find((model) => model.id === target.model)?.contextLength || 200_000
    } else {
      contextLength = await resolveOpenAIContext(instance, target.model)
    }
    if (contextLength) {
      return { ok: true, contextLength, reliable: true, source: 'provider' }
    }
    return { ok: true, contextLength: 32_768, reliable: false, source: 'fallback' }
  } catch (error) {
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
