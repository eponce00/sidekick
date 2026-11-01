import { describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import { ProviderSetupError } from '../../shared/providerErrors'
import {
  assertProviderModelAllowed,
  resolveProviderDraft,
  resolveProviderInstance
} from './providerResolver'

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../ipc/settings', () => ({ loadStoredSettings: () => settings.current }))

function instance(models: ProviderInstance['models']): ProviderInstance {
  return {
    id: 'provider-1',
    name: 'Private provider',
    type: 'openai-compatible',
    preset: 'generic',
    enabled: true,
    baseUrl: 'https://provider.test/v1',
    modelSource: 'discover',
    models
  }
}

describe('provider model authorization', () => {
  it('allows enabled inventory models and legacy instances without an inventory', () => {
    expect(() =>
      assertProviderModelAllowed(instance([{ id: 'enabled', enabled: true }]), 'enabled')
    ).not.toThrow()
    expect(() => assertProviderModelAllowed(instance([]), 'legacy-model')).not.toThrow()
  })

  it('rejects disabled and unconfigured models before a provider request can use credentials', () => {
    const configured = instance([{ id: 'disabled', enabled: false }])
    expect(() => assertProviderModelAllowed(configured, 'disabled')).toThrow('disabled')
    expect(() => assertProviderModelAllowed(configured, 'other')).toThrow('not configured')
    expect(() => assertProviderModelAllowed(configured, 'other')).toThrow(ProviderSetupError)
  })

  it('names the provider a chat still points at after it was removed', () => {
    settings.current = { providerInstances: [instance([])] }
    const resolve = () =>
      resolveProviderInstance({
        providerInstanceId: 'removed',
        providerKind: 'litellm',
        model: 'local-model'
      })
    expect(resolve).toThrow(ProviderSetupError)
    expect(resolve).toThrow('Provider removed is not set up')
  })
})

describe('provider instance resolution', () => {
  // Legacy endpoint settings stay in the store after provider instances replace them, and their
  // LM Studio address is the default every install has.
  const legacyEndpoints = {
    lmStudioEndpoint: 'http://localhost:1234/v1',
    ollamaEndpoint: 'http://localhost:11434',
    llamaCppEndpoint: 'http://localhost:8080/v1'
  }
  const target = {
    providerInstanceId: 'provider-1',
    providerKind: 'openai-compatible' as const,
    model: 'enabled'
  }

  it('never sends a chat pinned to a missing provider to the legacy local server', () => {
    // A provider deleted, or not saved yet when the run starts.
    settings.current = { ...legacyEndpoints, providerInstances: [] }
    expect(() => resolveProviderInstance(target)).toThrow(ProviderSetupError)
    expect(() => resolveProviderInstance(target)).toThrow('Provider provider-1 is not set up')
    expect(() => resolveProviderInstance(target, false)).toThrow(ProviderSetupError)
    // Settings from before provider instances, with none stored.
    settings.current = { ...legacyEndpoints }
    expect(() => resolveProviderInstance(target)).toThrow('Provider provider-1 is not set up')
  })

  it('does not fall back to a legacy server for a chat without a pinned provider either', () => {
    settings.current = { ...legacyEndpoints, providerInstances: [] }
    expect(() =>
      resolveProviderInstance({ providerKind: 'lmstudio', model: 'any-model' }, false)
    ).toThrow('Provider LM Studio is not configured')
  })

  it('refuses a disabled provider rather than using another one of its kind', () => {
    const disabled = { ...instance([{ id: 'enabled', enabled: true }]), enabled: false }
    const other = {
      ...instance([{ id: 'enabled', enabled: true }]),
      id: 'provider-2',
      name: 'Other provider',
      baseUrl: 'https://other.test/v1'
    }
    settings.current = { ...legacyEndpoints, providerInstances: [disabled, other] }
    expect(() => resolveProviderInstance(target)).toThrow('Provider Private provider is disabled')
  })

  it('follows a renamed provider by its id and fails closed when its id changed', () => {
    const renamed = { ...instance([{ id: 'enabled', enabled: true }]), name: 'Renamed provider' }
    settings.current = { ...legacyEndpoints, providerInstances: [renamed] }
    expect(resolveProviderInstance(target)).toMatchObject({
      id: 'provider-1',
      name: 'Renamed provider',
      baseUrl: 'https://provider.test/v1'
    })

    settings.current = {
      ...legacyEndpoints,
      providerInstances: [{ ...renamed, id: 'provider-1-renamed' }]
    }
    expect(() => resolveProviderInstance(target)).toThrow('Provider provider-1 is not set up')
  })

  it('finds an enabled provider of the requested kind for a chat without a pinned provider', () => {
    settings.current = {
      ...legacyEndpoints,
      providerInstances: [instance([{ id: 'enabled', enabled: true }])]
    }
    expect(
      resolveProviderInstance({ providerKind: 'openai-compatible', model: 'enabled' })
    ).toMatchObject({ id: 'provider-1', baseUrl: 'https://provider.test/v1' })
  })
})

describe('provider draft resolution', () => {
  const saved = { ...instance([]), apiKey: 'saved-key' }
  const draft = (baseUrl: string): ProviderInstance => ({
    ...instance([]),
    baseUrl,
    apiKeyConfigured: true
  })

  it('uses the saved key for a draft at the address it was saved with', () => {
    settings.current = { providerInstances: [saved] }
    expect(resolveProviderDraft(draft('https://provider.test/v1/')).apiKey).toBe('saved-key')
  })

  it('asks for the key again instead of sending the saved one to a different address', () => {
    settings.current = { providerInstances: [saved] }
    expect(() => resolveProviderDraft(draft('https://elsewhere.test/v1'))).toThrow(
      ProviderSetupError
    )
    expect(
      resolveProviderDraft({ ...draft('https://elsewhere.test/v1'), apiKey: 'typed-key' }).apiKey
    ).toBe('typed-key')
  })
})
