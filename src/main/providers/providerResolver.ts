import {
  providerDefinition,
  providerKindForInstance,
  type ProviderKind
} from '../../shared/providerRegistry'
import type { ProviderInstance, ProviderSettings } from '../../shared/settings'
import type { ProviderTarget } from '../../shared/providerRuntime'
import { loadStoredSettings } from '../ipc/settings'

function settings(): ProviderSettings {
  return loadStoredSettings() as unknown as ProviderSettings
}

function assertEndpoint(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider base URL must use HTTP or HTTPS')
  }
  return normalized
}

function legacyInstance(
  kind: ProviderKind,
  current: ProviderSettings
): ProviderInstance | undefined {
  const definition = providerDefinition(kind)
  const legacy = (() => {
    switch (kind) {
      case 'ollama':
        return { baseUrl: current.ollamaEndpoint }
      case 'ollama-cloud':
        return {
          baseUrl: current.ollamaCloudBaseUrl || definition.defaultBaseUrl,
          apiKey: current.ollamaCloudApiKey
        }
      case 'openrouter':
        return { baseUrl: definition.defaultBaseUrl, apiKey: current.openRouterApiKey }
      case 'lmstudio':
      case 'openai-compatible':
        return { baseUrl: current.lmStudioEndpoint, apiKey: current.lmStudioApiKey }
      case 'llamacpp':
        return { baseUrl: current.llamaCppEndpoint }
      case 'litellm':
      case 'anthropic':
        return undefined
    }
  })()
  if (!legacy?.baseUrl) return undefined
  return {
    id: `legacy-${kind}`,
    name: definition.name,
    type: definition.type,
    preset: definition.preset,
    enabled: true,
    baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey,
    modelSource: definition.capabilities.discovery === 'manual' ? 'manual' : 'discover',
    models: []
  }
}

function withPersistedSecret(draft: ProviderInstance, current: ProviderSettings): ProviderInstance {
  if (draft.apiKey?.trim() || !draft.apiKeyConfigured) return draft
  const stored = current.providerInstances?.find((instance) => instance.id === draft.id)
  return stored?.apiKey ? { ...draft, apiKey: stored.apiKey } : draft
}

export function assertProviderModelAllowed(instance: ProviderInstance, model: string): void {
  if (instance.models.length === 0) return
  const configured = instance.models.find((candidate) => candidate.id === model)
  if (!configured) throw new Error(`Model ${model} is not configured for ${instance.name}`)
  if (!configured.enabled) throw new Error(`Model ${model} is disabled for ${instance.name}`)
}

export function resolveProviderInstance(
  target: Pick<ProviderTarget, 'providerInstanceId' | 'providerKind' | 'model'>,
  requireEnabledModel = true
): ProviderInstance {
  const current = settings()
  const instances = current.providerInstances || []
  const instance = target.providerInstanceId
    ? instances.find((candidate) => candidate.id === target.providerInstanceId)
    : instances.find(
        (candidate) =>
          candidate.enabled && providerKindForInstance(candidate) === target.providerKind
      )
  const resolved = instance || legacyInstance(target.providerKind, current)
  if (!resolved) throw new Error(`Provider ${target.providerKind} is not configured`)
  if (!resolved.enabled) throw new Error(`Provider ${resolved.name} is disabled`)
  const actualKind = providerKindForInstance(resolved)
  if (actualKind !== target.providerKind) {
    throw new Error(`Selected model belongs to ${actualKind}, not ${target.providerKind}`)
  }
  if (requireEnabledModel) assertProviderModelAllowed(resolved, target.model)
  return { ...resolved, baseUrl: assertEndpoint(resolved.baseUrl) }
}

export function resolveProviderDraft(draft: ProviderInstance): ProviderInstance {
  const resolved = withPersistedSecret(draft, settings())
  return { ...resolved, baseUrl: assertEndpoint(resolved.baseUrl) }
}

export function resolveProviderInstanceById(id: string): ProviderInstance {
  const current = settings()
  const instance = current.providerInstances?.find((candidate) => candidate.id === id)
  if (!instance) throw new Error(`Provider instance ${id} was not found`)
  return { ...instance, baseUrl: assertEndpoint(instance.baseUrl) }
}

export function requireProviderApiKey(instance: ProviderInstance): string {
  const key = instance.apiKey?.trim()
  if (!key) throw new Error(`${instance.name} requires an API key`)
  return key
}
