import type { ProviderKind } from '../../../shared/providerRegistry'
import type { ModelProvider, PinnedModel } from '../types/models.types'

export type ProviderIconKind = ModelProvider | ProviderKind

export function parseProviderFromModelId(modelId: string): ProviderIconKind {
  if (modelId.startsWith('ollama-cloud:')) return 'ollama-cloud'
  if (modelId.startsWith('openrouter:')) return 'openrouter'
  if (modelId.startsWith('anthropic:')) return 'anthropic'
  if (modelId.startsWith('litellm:')) return 'litellm'
  if (modelId.startsWith('openai-compatible:')) return 'openai-compatible'
  if (modelId.startsWith('lmstudio:')) return 'lmstudio'
  if (modelId.startsWith('llamacpp:')) return 'llamacpp'
  return 'ollama'
}

export function providerIconKindForModel(
  model: Pick<PinnedModel, 'provider' | 'providerKind'>
): ProviderIconKind {
  return model.providerKind ?? model.provider
}
