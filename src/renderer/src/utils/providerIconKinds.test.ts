import { describe, expect, it } from 'vitest'
import { providerIconKindForModel } from './providerIconKinds'

describe('provider icon kinds', () => {
  it('uses the provider kind instead of a shared transport when available', () => {
    expect(
      providerIconKindForModel({ provider: 'lmstudio', providerKind: 'openai-compatible' })
    ).toBe('openai-compatible')
    expect(providerIconKindForModel({ provider: 'lmstudio', providerKind: 'lmstudio' })).toBe(
      'lmstudio'
    )
  })
})
