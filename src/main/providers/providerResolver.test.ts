import { describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import { ProviderSetupError } from '../../shared/providerErrors'
import { assertProviderModelAllowed, resolveProviderInstance } from './providerResolver'

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
    expect(resolve).toThrow('Provider LiteLLM is not configured')
  })
})
