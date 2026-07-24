import type { PinnedModel } from '../../../shared/models'
import type { ProviderTarget } from '../../../shared/providerRuntime'
import type { ProviderKind } from '../../../shared/providerRegistry'

export function providerTargetForPinnedModel(model: PinnedModel): ProviderTarget {
  return {
    providerInstanceId: model.providerInstanceId,
    providerKind: (model.providerKind || model.provider) as ProviderKind,
    model: model.providerModelId || model.name,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    editingDialect: model.editingDialect,
    upstreamModel: model.upstreamModel,
    editingCalibration: model.editingCalibration
  }
}

export function pinnedModelForProviderTarget(
  models: PinnedModel[],
  target: ProviderTarget
): PinnedModel | undefined {
  return models.find((model) => {
    const modelKind = (model.providerKind || model.provider) as ProviderKind
    const modelName = model.providerModelId || model.name
    if (target.providerInstanceId) {
      return model.providerInstanceId === target.providerInstanceId && modelName === target.model
    }
    return modelKind === target.providerKind && modelName === target.model
  })
}
