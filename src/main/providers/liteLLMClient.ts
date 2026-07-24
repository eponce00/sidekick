import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'
import {
  fetchOpenAICompatibleModels,
  normalizeOpenAICompatibleEndpoint,
  type OpenAICompatibleModel,
  type OpenAICompatibleResult
} from './openAICompatibleClient'

type FetchImplementation = typeof fetch

interface LiteLLMMetadataRecord extends Partial<OpenAICompatibleModel> {
  id?: string
  model?: string
  model_name?: string
  model_group?: string
  litellm_params?: {
    model?: string
    [key: string]: unknown
  }
  model_info?: Partial<OpenAICompatibleModel> & Record<string, unknown>
}

interface LiteLLMMetadataResponse {
  data?: LiteLLMMetadataRecord[]
  models?: LiteLLMMetadataRecord[]
  model_groups?: LiteLLMMetadataRecord[]
}

const METADATA_FIELDS = [
  'context_length',
  'max_model_len',
  'max_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'input_cost_per_token',
  'output_cost_per_token',
  'supports_function_calling',
  'supports_parallel_function_calling',
  'supports_vision',
  'supports_reasoning',
  'supports_audio_input',
  'supports_audio_output',
  'supports_pdf_input',
  'supported_openai_params',
  'mode'
] as const

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined
}

export function openAIModelContextLength(
  model: Partial<OpenAICompatibleModel>
): number | undefined {
  const info = model.model_info || {}
  return (
    positiveInteger(model.context_length) ||
    positiveInteger(info.context_length) ||
    positiveInteger(model.max_model_len) ||
    positiveInteger(info.max_model_len) ||
    positiveInteger(model.max_input_tokens) ||
    positiveInteger(info.max_input_tokens) ||
    positiveInteger(model.max_tokens) ||
    positiveInteger(info.max_tokens)
  )
}

function supportedParams(model: Partial<OpenAICompatibleModel>): string[] {
  const params = model.supported_openai_params || model.model_info?.supported_openai_params
  return Array.isArray(params)
    ? params.filter((item): item is string => typeof item === 'string')
    : []
}

export function normalizeOpenAIModelMetadata(model: OpenAICompatibleModel): ProviderInstanceModel {
  const info = model.model_info || {}
  const params = supportedParams(model)
  const contextLength = openAIModelContextLength(model)
  const maxInputTokens =
    positiveInteger(model.max_input_tokens) ||
    positiveInteger(info.max_input_tokens) ||
    contextLength
  const maxOutputTokens =
    positiveInteger(model.max_output_tokens) || positiveInteger(info.max_output_tokens)
  const supportsTools =
    boolean(model.supports_function_calling) ??
    boolean(info.supports_function_calling) ??
    (params.includes('tools') || params.includes('functions') ? true : undefined)
  const supportsVision = boolean(model.supports_vision) ?? boolean(info.supports_vision)
  const supportsReasoning = boolean(model.supports_reasoning) ?? boolean(info.supports_reasoning)
  const supportsAudioInput =
    boolean(model.supports_audio_input) ?? boolean(info.supports_audio_input)
  const supportsAudioOutput =
    boolean(model.supports_audio_output) ?? boolean(info.supports_audio_output)
  const supportsPdfInput = boolean(model.supports_pdf_input) ?? boolean(info.supports_pdf_input)
  const promptPrice =
    finiteNumber(model.input_cost_per_token) ?? finiteNumber(info.input_cost_per_token)
  const completionPrice =
    finiteNumber(model.output_cost_per_token) ?? finiteNumber(info.output_cost_per_token)
  const hasProviderMetadata = [
    contextLength,
    maxOutputTokens,
    supportsTools,
    supportsVision,
    supportsReasoning,
    supportsAudioInput,
    supportsAudioOutput,
    supportsPdfInput,
    promptPrice,
    completionPrice
  ].some((value) => value !== undefined)

  return {
    id: model.id,
    name: model.name || model.id,
    enabled: false,
    contextLength,
    maxInputTokens,
    maxOutputTokens,
    supportsTools,
    supportsVision,
    supportsReasoning,
    supportsAudioInput,
    supportsAudioOutput,
    supportsPdfInput,
    upstreamModel:
      typeof model.upstream_model_id === 'string' && model.upstream_model_id.trim()
        ? model.upstream_model_id.trim()
        : undefined,
    metadataSource: hasProviderMetadata ? 'provider' : 'unknown',
    pricing:
      promptPrice !== undefined && completionPrice !== undefined
        ? { prompt: promptPrice, completion: completionPrice }
        : undefined
  }
}

function recordsFromResponse(
  payload: LiteLLMMetadataResponse | LiteLLMMetadataRecord[]
): LiteLLMMetadataRecord[] | undefined {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  if (Array.isArray(payload.model_groups)) return payload.model_groups
  return undefined
}

function recordIds(record: LiteLLMMetadataRecord): string[] {
  return [record.model_group, record.model_name, record.id, record.model].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
}

function metadataFromRecord(record: LiteLLMMetadataRecord): Partial<OpenAICompatibleModel> {
  const merged: Record<string, unknown> = { ...(record.model_info || {}) }
  for (const field of METADATA_FIELDS) {
    if (record[field] !== undefined) merged[field] = record[field]
  }
  return merged
}

function metadataEndpoints(endpoint: string): string[] {
  const normalized = normalizeOpenAICompatibleEndpoint(endpoint)
  const root = normalized.replace(/\/v1$/, '')
  return Array.from(
    new Set([
      `${normalized}/model_group/info`,
      `${normalized}/model/info`,
      `${root}/model_group/info`,
      `${root}/model/info`
    ])
  )
}

async function fetchOptionalMetadata(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation,
  signal?: AbortSignal
): Promise<LiteLLMMetadataRecord[]> {
  try {
    const response = await fetchImpl(url, { headers, signal })
    if (!response.ok) return []
    const payload = (await response.json()) as LiteLLMMetadataResponse | LiteLLMMetadataRecord[]
    return recordsFromResponse(payload) || []
  } catch {
    return []
  }
}

export function applyProviderModelOverrides(
  discovered: ProviderInstanceModel,
  configured: ProviderInstanceModel | undefined
): ProviderInstanceModel {
  const overrides = configured?.metadataOverrides
  return {
    ...discovered,
    enabled: configured?.enabled ?? false,
    name: configured?.name || discovered.name,
    editingDialect: configured?.editingDialect,
    upstreamModel: discovered.upstreamModel || configured?.upstreamModel,
    editingCalibration: configured?.editingCalibration,
    ...(overrides || {}),
    metadataOverrides: overrides,
    metadataSource:
      overrides && Object.keys(overrides).length > 0 ? 'configured' : discovered.metadataSource
  }
}

export async function discoverLiteLLMModels(
  instance: ProviderInstance,
  headers: Record<string, string>,
  fetchImpl: FetchImplementation = fetch,
  signal?: AbortSignal
): Promise<OpenAICompatibleResult<{ models: ProviderInstanceModel[] }>> {
  const catalog = await fetchOpenAICompatibleModels(instance.baseUrl, headers, fetchImpl, signal)
  if (!catalog.ok || !catalog.data) {
    return { ok: false, error: catalog.error, status: catalog.status }
  }

  const models = new Map<string, OpenAICompatibleModel>()
  for (const model of catalog.data.data) models.set(model.id, { ...model })

  const metadataResponses = await Promise.all(
    metadataEndpoints(instance.baseUrl).map((endpoint) =>
      fetchOptionalMetadata(endpoint, headers, fetchImpl, signal)
    )
  )
  for (const records of metadataResponses) {
    for (const record of records) {
      const upstreamModel = record.litellm_params?.model
      const metadata = {
        ...metadataFromRecord(record),
        ...(typeof upstreamModel === 'string' && upstreamModel.trim()
          ? { upstream_model_id: upstreamModel.trim() }
          : {})
      }
      for (const id of recordIds(record)) {
        const existing = models.get(id)
        if (existing) models.set(id, { ...existing, ...metadata, id })
      }
    }
  }

  return {
    ok: true,
    data: {
      models: Array.from(models.values())
        .map((model) =>
          applyProviderModelOverrides(
            normalizeOpenAIModelMetadata(model),
            instance.models.find((configured) => configured.id === model.id)
          )
        )
        .sort((left, right) => left.id.localeCompare(right.id))
    }
  }
}
