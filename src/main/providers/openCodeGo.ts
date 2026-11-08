import { createHash, randomUUID } from 'node:crypto'
import packageMetadata from '../../../package.json'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'
import { isReasoningLevel, REASONING_INTENSITY, type ReasoningLevel } from '../../shared/reasoning'
import type { ProviderInstance, ProviderInstanceModel } from '../../shared/settings'
import { normalizeOpenAIModelMetadata } from './liteLLMClient'
import { boolean, finiteNumber, hasReportedMetadata, positiveInteger } from './modelCatalog'
import { fetchOpenAICompatibleModels, type OpenAICompatibleModel } from './openAICompatibleClient'

/** Go's catalog and Chat Completions live at different paths on the same trusted origin. */
export function openCodeGoEndpoints(
  instance: Pick<ProviderInstance, 'type' | 'baseUrl'>
): { chat: string; catalog: string } | undefined {
  if (instance.type !== 'openai-compatible') return undefined
  try {
    const url = new URL(instance.baseUrl.trim())
    if (
      url.origin !== 'https://opencode.ai' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![
        '/inference/go',
        '/inference/go/v1',
        '/inference/go/openai/v1',
        '/inference/go/openai/v1/chat/completions'
      ].includes(url.pathname.replace(/\/+$/, ''))
    )
      return undefined
    return {
      chat: 'https://opencode.ai/inference/go/openai/v1',
      catalog: 'https://opencode.ai/inference/go/v1'
    }
  } catch {
    return undefined
  }
}

export function openCodeGoHeaders(conversationId?: string): Record<string, string> {
  // Preserve routing and caching without disclosing local chat identifiers.
  const session = createHash('sha256')
    .update(typeof conversationId === 'string' && conversationId ? conversationId : randomUUID())
    .digest('hex')
  return {
    'User-Agent': `${PRODUCT_IDENTITY.productName}/${packageMetadata.version}`,
    'x-opencode-session': `ses_${session}`
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

function effortLevel(value: unknown): ReasoningLevel | undefined {
  const effort = record(value).value ?? value
  if (effort === 'none') return 'off'
  return isReasoningLevel(effort) ? effort : undefined
}

export function normalizeOpenCodeGoModel(model: OpenAICompatibleModel): ProviderInstanceModel {
  const raw = model as unknown as Record<string, unknown>
  const generic = normalizeOpenAIModelMetadata(model)
  const limit = record(raw.limit)
  const capabilities = record(raw.capabilities)
  const reasoning = record(capabilities.reasoning)
  const supportsReasoning = boolean(reasoning.supported) ?? generic.supportsReasoning
  const efforts = strings(reasoning.effort)
    ?.map(effortLevel)
    .filter((level) => level !== undefined)
  const modalities = record(raw.modalities)
  const inputs = strings(modalities.input)
  const outputs = strings(modalities.output)
  const accepts = (kind: string): boolean | undefined =>
    inputs?.some((value) => value === kind || value.startsWith(`${kind}/`))
  const cost = record(record(raw.cost).text)
  const prompt = finiteNumber(record(cost.input).price)
  const completion = finiteNumber(record(cost.output).price)
  const contextLength = positiveInteger(limit.context) ?? generic.contextLength
  const normalized: ProviderInstanceModel = {
    ...generic,
    contextLength,
    maxInputTokens: positiveInteger(limit.input) ?? generic.maxInputTokens ?? contextLength,
    outputTokenLimit: positiveInteger(limit.output) ?? generic.outputTokenLimit,
    supportsTools: boolean(record(capabilities.tools).supported) ?? generic.supportsTools,
    supportsVision: accepts('image') ?? generic.supportsVision,
    supportsReasoning,
    reasoningLevels:
      supportsReasoning !== undefined
        ? supportsReasoning && efforts
          ? REASONING_INTENSITY.filter((level) => efforts.includes(level))
          : []
        : generic.reasoningLevels,
    reasoningDefault: effortLevel(reasoning.default),
    supportsAudioInput: accepts('audio') ?? generic.supportsAudioInput,
    supportsAudioOutput:
      outputs?.some((value) => value === 'audio' || value.startsWith('audio/')) ??
      generic.supportsAudioOutput,
    supportsPdfInput: inputs?.includes('application/pdf') ?? generic.supportsPdfInput,
    // Catalog prices are per million tokens; SideKick stores prices per token.
    pricing:
      prompt !== undefined && completion !== undefined
        ? { prompt: prompt / 1_000_000, completion: completion / 1_000_000 }
        : generic.pricing
  }
  normalized.metadataSource = hasReportedMetadata(normalized) ? 'provider' : 'unknown'
  return normalized
}

export async function discoverOpenCodeGoModels(
  instance: ProviderInstance,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; models?: ProviderInstanceModel[]; error?: string; status?: number }> {
  const endpoints = openCodeGoEndpoints(instance)
  if (!endpoints) return { ok: false, error: 'Invalid OpenCode Go endpoint' }
  const result = await fetchOpenAICompatibleModels(endpoints.catalog, headers, fetchImpl, signal)
  if (!result.ok || !result.data) return result
  return {
    ok: true,
    models: result.data.data
      .filter((model) => {
        const entry = record(model)
        return (
          typeof entry.id === 'string' &&
          entry.id.trim().length > 0 &&
          (entry.type === undefined || entry.type === 'chat')
        )
      })
      .map(normalizeOpenCodeGoModel)
  }
}
