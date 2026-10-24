import type { ProviderInstanceModel } from '../../shared/settings'
import { lmStudioReasoning, openRouterReasoning } from './reasoningCapabilities'

type FetchImplementation = typeof fetch

export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

export function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined
}

/** Whether any field beyond the id and name came from the provider. */
export function hasReportedMetadata(model: ProviderInstanceModel): boolean {
  return [
    model.contextLength,
    model.maxOutputTokens,
    model.outputTokenLimit,
    model.supportsTools,
    model.supportsVision,
    model.supportsReasoning,
    model.supportsAudioInput,
    model.supportsAudioOutput,
    model.supportsPdfInput,
    model.pricing
  ].some((value) => value !== undefined)
}

/**
 * LiteLLM-style modes that cannot hold a chat. A catalog lists embedding, image, speech and
 * rerank models beside chat models; offering them in chat would only fail on the first message.
 */
const NON_CHAT_MODES = new Set([
  'embedding',
  'embeddings',
  'image_generation',
  'audio_transcription',
  'audio_speech',
  'moderation',
  'rerank'
])

export function isChatModelMode(mode: unknown): boolean {
  return typeof mode !== 'string' || !NON_CHAT_MODES.has(mode.trim().toLowerCase())
}

/**
 * Lays a fresh catalog entry over what the user configured for the same model: their choice to
 * show it, its name if they gave one, and their overrides win; everything else is the provider's.
 */
export function applyProviderModelOverrides(
  discovered: ProviderInstanceModel,
  configured: ProviderInstanceModel | undefined
): ProviderInstanceModel {
  const overrides = configured?.metadataOverrides
  const namedByUser = configured?.name && configured.name !== configured.id
  return {
    ...discovered,
    enabled: configured?.enabled ?? false,
    name: namedByUser ? configured.name : discovered.name,
    editingDialect: configured?.editingDialect,
    upstreamModel: discovered.upstreamModel || configured?.upstreamModel,
    editingCalibration: configured?.editingCalibration,
    ...(overrides || {}),
    metadataOverrides: overrides,
    metadataSource:
      overrides && Object.keys(overrides).length > 0 ? 'configured' : discovered.metadataSource
  }
}

export interface OpenRouterCatalogModel {
  id: string
  name?: string
  context_length?: number
  supported_parameters?: string[]
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null }
  pricing?: { prompt?: string | number; completion?: string | number }
  /** Which efforts the model takes, whether it can stop reasoning, and its defaults. */
  reasoning?: unknown
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

/** One OpenRouter catalog entry, read from its documented `/models` fields. */
export function normalizeOpenRouterModel(model: OpenRouterCatalogModel): ProviderInstanceModel {
  const params = stringList(model.supported_parameters)
  const inputs = stringList(model.architecture?.input_modalities)
  const outputs = stringList(model.architecture?.output_modalities)
  // Older entries describe modalities only as "text+image->text".
  const modality = model.architecture?.modality
  const accepts = (kind: string): boolean | undefined =>
    inputs
      ? inputs.includes(kind)
      : typeof modality === 'string'
        ? modality.split('->')[0].includes(kind)
        : undefined
  const reasoning = openRouterReasoning(model.reasoning)
  const prompt = finiteNumber(model.pricing?.prompt)
  const completion = finiteNumber(model.pricing?.completion)
  const normalized: ProviderInstanceModel = {
    id: model.id,
    name: model.name || model.id,
    enabled: false,
    contextLength:
      positiveInteger(model.context_length) || positiveInteger(model.top_provider?.context_length),
    outputTokenLimit: positiveInteger(model.top_provider?.max_completion_tokens),
    // OpenRouter lists the parameters each model takes; tools and reasoning are among them.
    supportsTools: params ? params.includes('tools') : undefined,
    supportsReasoning:
      reasoning.supportsReasoning ??
      (params ? params.includes('reasoning') || params.includes('include_reasoning') : undefined),
    reasoningLevels: reasoning.reasoningLevels,
    reasoningDefault: reasoning.reasoningDefault,
    supportsVision: accepts('image'),
    supportsPdfInput: accepts('file'),
    supportsAudioInput: accepts('audio'),
    supportsAudioOutput: outputs ? outputs.includes('audio') : undefined,
    pricing: prompt !== undefined && completion !== undefined ? { prompt, completion } : undefined
  }
  return { ...normalized, metadataSource: hasReportedMetadata(normalized) ? 'provider' : 'unknown' }
}

/** Whether an OpenRouter entry produces text, so a chat can use it. */
export function openRouterModelChats(model: OpenRouterCatalogModel): boolean {
  const outputs = stringList(model.architecture?.output_modalities)
  return !outputs || outputs.includes('text')
}

interface LMStudioNativeModel {
  /** `/api/v1/models` names a model by `key`; `/api/v0/models` by `id`. */
  key?: string
  id?: string
  display_name?: string
  type?: string
  max_context_length?: number
  capabilities?: {
    vision?: boolean
    trained_for_tool_use?: boolean
    reasoning?: unknown
  }
}

/**
 * LM Studio's own model list says what the OpenAI-compatible list leaves out: whether a model
 * chats or only embeds, its context window, and, from LM Studio 0.4, vision, tool use and
 * reasoning. The newer list is tried first; a server without it falls back to the older one.
 */
export async function fetchLMStudioModelDetails(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<Map<string, LMStudioNativeModel>> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  for (const path of ['/api/v1/models', '/api/v0/models']) {
    try {
      const response = await fetchImpl(`${root}${path}`, { headers, signal })
      if (!response.ok) continue
      const payload = (await response.json()) as {
        models?: LMStudioNativeModel[]
        data?: LMStudioNativeModel[]
      }
      const list = payload.models ?? payload.data
      if (!Array.isArray(list)) continue
      const details = new Map<string, LMStudioNativeModel>()
      for (const model of list) {
        const id = model.key ?? model.id
        if (typeof id === 'string' && id) details.set(id, model)
      }
      return details
    } catch {
      signal?.throwIfAborted()
    }
  }
  return new Map()
}

/** Whether an LM Studio model can hold a chat; embedding models cannot. */
export function lmStudioModelChats(details: LMStudioNativeModel | undefined): boolean {
  return !details?.type || !details.type.toLowerCase().startsWith('embedding')
}

export function withLMStudioDetails(
  model: ProviderInstanceModel,
  details: LMStudioNativeModel | undefined
): ProviderInstanceModel {
  if (!details) return model
  const capabilities = details.capabilities
  const enriched: ProviderInstanceModel = {
    ...model,
    name: details.display_name || model.name,
    contextLength: model.contextLength ?? positiveInteger(details.max_context_length),
    supportsVision:
      model.supportsVision ??
      boolean(capabilities?.vision) ??
      (details.type === 'vlm' ? true : undefined),
    supportsTools: model.supportsTools ?? boolean(capabilities?.trained_for_tool_use),
    ...lmStudioReasoning(capabilities?.reasoning),
    ...(model.supportsReasoning !== undefined ? { supportsReasoning: model.supportsReasoning } : {})
  }
  return {
    ...enriched,
    metadataSource: hasReportedMetadata(enriched) ? 'provider' : enriched.metadataSource
  }
}
