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
  type ProviderDefinition,
  type ProviderKind
} from './providerRegistry'

/** A new, empty instance of a provider type, as the Settings window and the CLI create one. */
export function createProviderInstance(
  template: ProviderDefinition,
  id: string,
  name: string = template.name
): ProviderInstance {
  return {
    id,
    name,
    type: template.type,
    preset: template.preset,
    enabled: true,
    baseUrl: template.defaultBaseUrl,
    modelSource: template.capabilities.discovery === 'manual' ? 'manual' : 'discover',
    models: []
  }
}

/**
 * Checks a provider base URL. Credentials in the URL are refused because they would be stored
 * and shown in plain text; use `sidekick auth set` for keys.
 */
export function validateProviderBaseUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Base URL must be a full http:// or https:// address.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL must use http:// or https://.'
  }
  if (url.username || url.password) {
    return 'Base URL must not contain a user name or password; store keys with sidekick auth set.'
  }
  return null
}

/** Whether requests to this URL leave the computer unencrypted. */
export function providerUrlIsUnencryptedRemote(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function transportForProviderType(type: ProviderInstanceType): ModelProvider {
  const kind: ProviderKind = type === 'openai-compatible' ? 'openai-compatible' : type
  return providerDefinition(kind).transport
}

export function transportForProviderInstance(
  instance: Pick<ProviderInstance, 'type' | 'preset'>
): ModelProvider {
  return providerDefinitionForInstance(instance).transport
}

/**
 * A provider's fresh model list, keeping what the user set up. Each listed model keeps whether it
 * is shown in chat; a model the provider no longer lists stays while it is shown in chat or has
 * overrides, so a refresh never takes away a model the user chose.
 */
export function mergeDiscoveredModels(
  configured: readonly ProviderInstanceModel[],
  discovered: readonly ProviderInstanceModel[]
): ProviderInstanceModel[] {
  const current = new Map(configured.map((model) => [model.id, model]))
  const listed = new Set(discovered.map(({ id }) => id))
  const kept = configured.filter(
    (model) =>
      !listed.has(model.id) &&
      (model.enabled || Object.keys(model.metadataOverrides ?? {}).length > 0)
  )
  return [
    ...discovered.map((model) => ({
      ...model,
      enabled: current.get(model.id)?.enabled ?? model.enabled
    })),
    ...kept
  ].sort((left, right) => left.id.localeCompare(right.id))
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
      reasoningLevels: model.reasoningLevels,
      reasoningDefault: model.reasoningDefault,
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
        outputTokenLimit: model.outputTokenLimit,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        supportsReasoning: model.supportsReasoning,
        reasoningLevels: model.reasoningLevels,
        reasoningDefault: model.reasoningDefault,
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
