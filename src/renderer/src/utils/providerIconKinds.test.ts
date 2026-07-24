import { describe, expect, it } from 'vitest'
import { parseProviderFromModelId, providerIconKindForModel } from './providerIconKinds'

describe('provider icon kinds', () => {
  it('uses the provider kind instead of a shared transport when available', () => {
    expect(
      providerIconKindForModel({ provider: 'lmstudio', providerKind: 'openai-compatible' })
    ).toBe('openai-compatible')
    expect(providerIconKindForModel({ provider: 'lmstudio', providerKind: 'lmstudio' })).toBe(
      'lmstudio'
    )
  })

  it('recognizes legacy provider-prefixed model ids', () => {
    expect(parseProviderFromModelId('openrouter:anthropic/claude')).toBe('openrouter')
    expect(parseProviderFromModelId('llamacpp:local/model')).toBe('llamacpp')
    expect(parseProviderFromModelId('openai-compatible:gateway/model')).toBe('openai-compatible')
    expect(parseProviderFromModelId('litellm:home/model')).toBe('litellm')
  })
})
