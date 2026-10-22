import type { ProviderKind } from '../../../shared/providerRegistry'
import type { ModelProvider, PinnedModel } from '../types/models.types'

export type ProviderIconKind = ModelProvider | ProviderKind

export function providerIconKindForModel(
  model: Pick<PinnedModel, 'provider' | 'providerKind'>
): ProviderIconKind {
  return model.providerKind ?? model.provider
}
