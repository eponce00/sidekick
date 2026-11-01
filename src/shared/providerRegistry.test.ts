import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  providerDefinition,
  providerDefinitionForInstance,
  providerDefinitionForTransport,
  providerKindForInstance
} from './providerRegistry'

describe('provider registry', () => {
  it('resolves definitions from runtime transports', () => {
    expect(providerDefinitionForTransport('lmstudio').kind).toBe('lmstudio')
    expect(providerDefinitionForTransport('anthropic').protocol).toBe('anthropic')
  })

  it('defines every provider kind once', () => {
    const kinds = PROVIDER_REGISTRY.map((definition) => definition.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('distinguishes LM Studio from generic OpenAI-compatible instances', () => {
    expect(providerKindForInstance({ type: 'openai-compatible', preset: 'lmstudio' })).toBe(
      'lmstudio'
    )
    expect(providerKindForInstance({ type: 'openai-compatible', preset: 'generic' })).toBe(
      'openai-compatible'
    )
    expect(
      providerDefinitionForInstance({ type: 'openai-compatible', preset: 'generic' }).capabilities
        .context
    ).toBe('openai-model-metadata')
    expect(providerDefinition('lmstudio').capabilities.context).toBe('lmstudio-native')
    expect(providerDefinition('litellm').capabilities.context).toBe('litellm-model-metadata')
  })
})
