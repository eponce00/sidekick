import type { ProviderInstance, ProviderInstanceModel } from '../../../../shared/settings'
import { inferVisionSupportFromModelName } from '../../utils/modelCapabilities'

type ProviderAPI = Pick<Window['api'], 'providers'>

export async function testProviderConnection(
  api: ProviderAPI,
  instance: ProviderInstance
): Promise<void> {
  const result = await api.providers.discoverModels({ draft: instance })
  if (!result.ok) throw new Error(result.error || 'Connection failed')
}

export async function discoverProviderModels(
  api: ProviderAPI,
  instance: ProviderInstance
): Promise<ProviderInstanceModel[]> {
  const result = await api.providers.discoverModels({ draft: instance })
  if (!result.ok || !result.models) throw new Error(result.error || 'Could not load models')
  return result.models
    .map((model): ProviderInstanceModel => {
      const inferredVision =
        model.supportsVision === undefined && inferVisionSupportFromModelName(model.id)
      return {
        ...model,
        supportsVision: inferredVision ? true : model.supportsVision,
        metadataSource:
          inferredVision && (!model.metadataSource || model.metadataSource === 'unknown')
            ? 'inferred'
            : model.metadataSource
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}
