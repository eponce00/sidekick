import {
  ControlError,
  type ControlMethods,
  type ControlProvider,
  type ControlProviderChange
} from '../../shared/controlProtocol'
import {
  PROVIDER_REGISTRY,
  providerKindForInstance,
  type ProviderDefinition
} from '../../shared/providerRegistry'
import { createProviderInstance, validateProviderBaseUrl } from '../../shared/providerInstances'
import type { ProviderInstance } from '../../shared/settings'
import type { SettingsRecord } from '../ipc/settings'
import type { AppStore } from '../ipc/state'
import { providerInstances, storedSettings } from './controlStore'

/** What the user sees before a provider's requests, and any stored key, go somewhere new. */
export interface ProviderEndpointChange {
  providerId: string
  providerName: string
  previousUrl: string | null
  nextUrl: string
  keyStored: boolean
}

export interface ProviderControlDependencies {
  store: AppStore
  settingsChanged: (settings: SettingsRecord) => void
  /** Shows the endpoint change in SideKick and resolves to the user's answer. */
  confirmProviderEndpoint: (change: ProviderEndpointChange) => Promise<boolean>
}

type ProviderHandlers = {
  [M in 'provider.list' | 'provider.add' | 'provider.set' | 'provider.remove']: (
    params: ControlMethods[M]['params']
  ) => Promise<ControlMethods[M]['result']>
}

const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,128}$/
const MAX_NAME_LENGTH = 80

function keyStored(settings: SettingsRecord, id: string): boolean {
  const secrets = settings.__encryptedProviderSecrets
  return Boolean(secrets && typeof secrets === 'object' && (secrets as Record<string, string>)[id])
}

function describe(instance: ProviderInstance, settings: SettingsRecord): ControlProvider {
  return {
    id: instance.id,
    name: instance.name,
    kind: providerKindForInstance(instance),
    enabled: instance.enabled !== false,
    baseUrl: instance.baseUrl,
    modelSource: instance.modelSource,
    enabledModels: instance.models.filter((model) => model.enabled).map((model) => model.id),
    apiKeyConfigured: keyStored(settings, instance.id)
  }
}

function checkedId(id: unknown): string {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) {
    throw new ControlError('usage', 'Name a provider instance id from `sidekick provider list`.')
  }
  return id
}

function checkedChange(change: ControlProviderChange): ControlProviderChange {
  const checked: ControlProviderChange = {}
  if (change.name !== undefined) {
    if (
      typeof change.name !== 'string' ||
      !change.name.trim() ||
      change.name.length > MAX_NAME_LENGTH ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f]/.test(change.name)
    ) {
      throw new ControlError(
        'invalid-value',
        `A name is 1 to ${MAX_NAME_LENGTH} characters of text.`
      )
    }
    checked.name = change.name.trim()
  }
  if (change.baseUrl !== undefined) {
    const invalid =
      typeof change.baseUrl === 'string'
        ? validateProviderBaseUrl(change.baseUrl)
        : 'Base URL must be text.'
    if (invalid) throw new ControlError('invalid-value', invalid)
    checked.baseUrl = change.baseUrl
  }
  if (change.enabled !== undefined) {
    if (typeof change.enabled !== 'boolean')
      throw new ControlError('usage', 'enabled is true or false.')
    checked.enabled = change.enabled
  }
  return checked
}

/**
 * Provider instance methods. A base URL decides where prompts and any stored key are sent, so
 * setting one that differs from the provider's default, or changing it, waits for the user's
 * approval in SideKick. Keys are stored only through `auth.set`.
 */
export function createProviderControlHandlers(deps: ProviderControlDependencies): ProviderHandlers {
  const { store } = deps

  function save(next: SettingsRecord): void {
    store.set('settings', next)
    deps.settingsChanged(next)
  }

  return {
    'provider.list': async () => {
      const settings = storedSettings(store)
      return {
        providers: providerInstances(settings).map((instance) => describe(instance, settings))
      }
    },

    'provider.add': async (params) => {
      const id = checkedId(params.id)
      const definition: ProviderDefinition | undefined = PROVIDER_REGISTRY.find(
        (candidate) => candidate.kind === params.kind
      )
      if (!definition) {
        throw new ControlError(
          'invalid-value',
          `Unknown provider kind. Use one of ${PROVIDER_REGISTRY.map((item) => item.kind).join(', ')}.`
        )
      }
      const change = checkedChange(params)
      if (providerInstances(storedSettings(store)).some((instance) => instance.id === id)) {
        throw new ControlError('invalid-value', `A provider instance named ${id} exists.`)
      }
      const instance: ProviderInstance = {
        ...createProviderInstance(definition, id, change.name),
        ...(change.baseUrl ? { baseUrl: change.baseUrl } : {}),
        ...(change.enabled === false ? { enabled: false } : {})
      }
      if (
        instance.baseUrl !== definition.defaultBaseUrl &&
        !(await deps.confirmProviderEndpoint({
          providerId: id,
          providerName: instance.name,
          previousUrl: null,
          nextUrl: instance.baseUrl,
          keyStored: false
        }))
      ) {
        throw new ControlError('denied', 'The provider address was declined in SideKick.')
      }
      const current = storedSettings(store)
      if (providerInstances(current).some((existing) => existing.id === id)) {
        throw new ControlError('invalid-value', `A provider instance named ${id} exists.`)
      }
      const next = {
        ...current,
        providerInstances: [
          ...(Array.isArray(current.providerInstances) ? current.providerInstances : []),
          instance
        ]
      }
      save(next)
      return { provider: describe(instance, next) }
    },

    'provider.set': async (params) => {
      const id = checkedId(params.id)
      const change = checkedChange(params)
      const before = providerInstances(storedSettings(store)).find((instance) => instance.id === id)
      if (!before)
        throw new ControlError(
          'not-found',
          'No provider instance has that id. Run `sidekick provider list`.'
        )
      if (
        change.baseUrl !== undefined &&
        change.baseUrl !== before.baseUrl &&
        !(await deps.confirmProviderEndpoint({
          providerId: id,
          providerName: before.name,
          previousUrl: before.baseUrl,
          nextUrl: change.baseUrl,
          keyStored: keyStored(storedSettings(store), id)
        }))
      ) {
        throw new ControlError('denied', 'The provider address change was declined in SideKick.')
      }
      // The dialog can stay open for a while; apply the change to what is stored now.
      const current = storedSettings(store)
      const instances = Array.isArray(current.providerInstances)
        ? (current.providerInstances as unknown[])
        : []
      let updated: ProviderInstance | undefined
      const changed: string[] = []
      const next = {
        ...current,
        providerInstances: instances.map((raw) => {
          const instance = raw as ProviderInstance
          if (!instance || instance.id !== id) return raw
          for (const key of Object.keys(change) as Array<keyof ControlProviderChange>) {
            if (instance[key] !== change[key]) changed.push(key)
          }
          updated = { ...instance, ...change }
          return updated
        })
      }
      if (!updated)
        throw new ControlError(
          'not-found',
          'No provider instance has that id. Run `sidekick provider list`.'
        )
      if (changed.length) save(next)
      return { provider: describe(updated, next), changed }
    },

    'provider.remove': async ({ id }) => {
      const checked = checkedId(id)
      const current = storedSettings(store)
      if (!providerInstances(current).some((instance) => instance.id === checked)) {
        throw new ControlError(
          'not-found',
          'No provider instance has that id. Run `sidekick provider list`.'
        )
      }
      const secrets = { ...((current.__encryptedProviderSecrets as Record<string, string>) ?? {}) }
      delete secrets[checked]
      save({
        ...current,
        providerInstances: (current.providerInstances as ProviderInstance[]).filter(
          (instance) => instance?.id !== checked
        ),
        __encryptedProviderSecrets: secrets
      })
      return { id: checked, removed: true }
    }
  }
}
