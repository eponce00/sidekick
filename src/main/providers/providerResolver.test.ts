import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import { assertProviderModelAllowed } from './providerResolver'

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
  })
})
