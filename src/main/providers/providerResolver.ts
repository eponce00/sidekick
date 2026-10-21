import {
  providerDefinition,
  providerKindForInstance,
  type ProviderKind
} from '../../shared/providerRegistry'
import type { ProviderInstance, ProviderSettings } from '../../shared/settings'
import type { ProviderTarget } from '../../shared/providerRuntime'
import { ProviderSetupError } from '../../shared/providerErrors'
import { loadStoredSettings } from '../ipc/settings'

function settings(): ProviderSettings {
  return loadStoredSettings() as unknown as ProviderSettings
}

function providerName(kind: ProviderKind): string {
  try {
    return providerDefinition(kind).name
  } catch {
    return kind
  }
}

function assertEndpoint(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider base URL must use HTTP or HTTPS')
  }
  return normalized
}

function withPersistedSecret(draft: ProviderInstance, current: ProviderSettings): ProviderInstance {
  if (draft.apiKey?.trim() || !draft.apiKeyConfigured) return draft
  const stored = current.providerInstances?.find((instance) => instance.id === draft.id)
  return stored?.apiKey ? { ...draft, apiKey: stored.apiKey } : draft
}

export function assertProviderModelAllowed(instance: ProviderInstance, model: string): void {
  if (instance.models.length === 0) return
  const configured = instance.models.find((candidate) => candidate.id === model)
  if (!configured)
    throw new ProviderSetupError(`Model ${model} is not configured for ${instance.name}`)
  if (!configured.enabled)
    throw new ProviderSetupError(`Model ${model} is disabled for ${instance.name}`)
}

export function resolveProviderInstance(
  target: Pick<ProviderTarget, 'providerInstanceId' | 'providerKind' | 'model'>,
  requireEnabledModel = true
): ProviderInstance {
  const instances = settings().providerInstances || []
  const id = target.providerInstanceId
  const resolved = id
    ? instances.find((candidate) => candidate.id === id)
    : instances.find(
        (candidate) =>
          candidate.enabled && providerKindForInstance(candidate) === target.providerKind
      )
  // A chat whose provider was removed, or is not saved yet, stops here. Falling back to another
  // configured server would send its whole prompt somewhere the user never chose for it.
  if (!resolved) {
    throw new ProviderSetupError(
      id
        ? `Provider ${id} is not set up`
        : `Provider ${providerName(target.providerKind)} is not configured`
    )
  }
  if (!resolved.enabled) throw new ProviderSetupError(`Provider ${resolved.name} is disabled`)
  const actualKind = providerKindForInstance(resolved)
  if (actualKind !== target.providerKind) {
    throw new ProviderSetupError(
      `Selected model belongs to ${providerName(actualKind)}, not ${providerName(target.providerKind)}`
    )
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
  if (!key) throw new ProviderSetupError(`${instance.name} requires an API key`)
  return key
}
