import type { PinnedModel, ModelProvider } from './models'
import type { ProviderTarget } from './providerRuntime'
import type {
  ProviderInstance,
  ProviderInstanceModel,
  ProviderInstanceType,
  ProviderSettings
} from './settings'
import {
  providerDefinition,
  providerDefinitionForInstance,
  type ProviderKind
} from './providerRegistry'

export function transportForProviderType(type: ProviderInstanceType): ModelProvider {
  const kind: ProviderKind = type === 'openai-compatible' ? 'openai-compatible' : type
  return providerDefinition(kind).transport
}

export function transportForProviderInstance(
  instance: Pick<ProviderInstance, 'type' | 'preset'>
): ModelProvider {
  return providerDefinitionForInstance(instance).transport
}

/** Refreshes persisted run targets from the provider model configuration. */
export function refreshProviderTargetMetadata(
  target: ProviderTarget,
  instances: readonly ProviderInstance[]
): ProviderTarget {
  const instance = target.providerInstanceId
    ? instances.find(({ id }) => id === target.providerInstanceId)
    : undefined
  const model = instance?.models.find(({ id }) => id === target.model)
  if (!model) return target
  return {
    ...target,
    contextLength:
      model.metadataOverrides?.contextLength ?? model.contextLength ?? target.contextLength,
    maxOutputTokens:
      model.metadataOverrides?.maxOutputTokens ?? model.maxOutputTokens ?? target.maxOutputTokens,
    editingDialect: model.editingDialect ?? target.editingDialect,
    upstreamModel: model.upstreamModel ?? target.upstreamModel,
    editingCalibration: model.editingCalibration ?? target.editingCalibration
  }
}

function legacyModelsForProvider(
  pinnedModels: PinnedModel[],
  provider: ModelProvider
): ProviderInstanceModel[] {
  return pinnedModels
    .filter((model) => model.provider === provider)
    .map((model) => ({
      id: model.providerModelId || model.name,
      name: model.name,
      enabled: true,
      contextLength: model.contextLength,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      supportsReasoning: model.supportsReasoning,
      supportsAudioInput: model.supportsAudioInput,
      supportsAudioOutput: model.supportsAudioOutput,
      supportsPdfInput: model.supportsPdfInput,
      editingDialect: model.editingDialect,
      upstreamModel: model.upstreamModel,
      editingCalibration: model.editingCalibration,
      pricing: model.pricing
    }))
}

export function migrateLegacyProviderInstances(
  settings: ProviderSettings,
  pinnedModels: PinnedModel[]
): ProviderInstance[] {
  if (settings.providerInstances?.length) return settings.providerInstances

  const instances: ProviderInstance[] = []
  const add = (
    id: string,
    name: string,
    type: ProviderInstanceType,
    baseUrl: string,
    apiKey: string | undefined,
    models: ProviderInstanceModel[],
    preset?: ProviderInstance['preset']
  ): void => {
    if (models.length === 0 && !apiKey) return
    instances.push({
      id,
      name,
      type,
      preset,
      enabled: true,
      baseUrl,
      apiKey,
      modelSource:
        providerDefinitionForInstance({ type, preset }).capabilities.discovery === 'manual'
          ? 'manual'
          : 'discover',
      models
    })
  }

  add(
    'ollama-local',
    'Ollama',
    'ollama',
    settings.ollamaEndpoint,
    undefined,
    legacyModelsForProvider(pinnedModels, 'ollama')
  )
  add(
    'ollama-cloud',
    'Ollama Cloud',
    'ollama-cloud',
    settings.ollamaCloudBaseUrl || 'https://ollama.com',
    settings.ollamaCloudApiKey,
    legacyModelsForProvider(pinnedModels, 'ollama-cloud')
  )
  add(
    'openrouter',
    'OpenRouter',
    'openrouter',
    'https://openrouter.ai/api/v1',
    settings.openRouterApiKey,
    legacyModelsForProvider(pinnedModels, 'openrouter')
  )
  add(
    'lm-studio',
    'LM Studio / OpenAI-compatible',
    'openai-compatible',
    settings.lmStudioEndpoint,
    settings.lmStudioApiKey,
    legacyModelsForProvider(pinnedModels, 'lmstudio'),
    'lmstudio'
  )
  add(
    'llama-cpp',
    'llama.cpp',
    'llamacpp',
    settings.llamaCppEndpoint,
    undefined,
    legacyModelsForProvider(pinnedModels, 'llamacpp')
  )
  return instances
}

export function pinnedModelsFromProviderInstances(instances: ProviderInstance[]): PinnedModel[] {
  return instances.flatMap((instance) => {
    if (!instance.enabled) return []
    const definition = providerDefinitionForInstance(instance)
    const provider = definition.transport
    return instance.models
      .filter((model) => model.enabled)
      .map((model) => ({
        id: `${provider}:${instance.id}/${model.id}`,
        name: model.name || model.id,
        provider,
        providerKind: definition.kind,
        providerInstanceId: instance.id,
        providerInstanceName: instance.name,
        providerModelId: model.id,
        providerHealth: instance.health,
        contextLength: model.contextLength,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        supportsReasoning: model.supportsReasoning,
        supportsAudioInput: model.supportsAudioInput,
        supportsAudioOutput: model.supportsAudioOutput,
        supportsPdfInput: model.supportsPdfInput,
        editingDialect: model.editingDialect,
        upstreamModel: model.upstreamModel,
        editingCalibration: model.editingCalibration,
        pricing: model.pricing
      }))
  })
}

export function syncLegacyProviderSettings(settings: ProviderSettings): ProviderSettings {
  const instances = settings.providerInstances || []
  const first = (type: ProviderInstanceType) =>
    instances.find((instance) => instance.enabled && instance.type === type)
  const ollama = first('ollama')
  const ollamaCloud = first('ollama-cloud')
  const openRouter = first('openrouter')
  const anthropic = first('anthropic')
  const openAICompatible = first('openai-compatible')
  const llamaCpp = first('llamacpp')
  return {
    ...settings,
    ollamaEndpoint: ollama?.baseUrl || settings.ollamaEndpoint,
    ollamaCloudBaseUrl: ollamaCloud?.baseUrl || settings.ollamaCloudBaseUrl,
    ollamaCloudApiKey: ollamaCloud ? '' : settings.ollamaCloudApiKey,
    openRouterApiKey: openRouter ? '' : settings.openRouterApiKey,
    fastModelAnthropic: anthropic?.fastModelId || settings.fastModelAnthropic,
    lmStudioEndpoint: openAICompatible?.baseUrl || settings.lmStudioEndpoint,
    lmStudioApiKey: openAICompatible ? '' : settings.lmStudioApiKey,
    llamaCppEndpoint: llamaCpp?.baseUrl || settings.llamaCppEndpoint
  }
}

export function providerInstanceForModel(
  settings: ProviderSettings,
  model: PinnedModel | undefined
): ProviderInstance | undefined {
  if (!model?.providerInstanceId) return undefined
  return settings.providerInstances?.find((instance) => instance.id === model.providerInstanceId)
}
