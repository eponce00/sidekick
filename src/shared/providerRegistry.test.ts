import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  providerDefinition,
  providerDefinitionForInstance,
  providerKindForInstance,
  providerUsesOpenAIProtocol
} from './providerRegistry'

describe('provider registry', () => {
  it('defines every provider kind once', () => {
    const kinds = PROVIDER_REGISTRY.map((definition) => definition.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds).toEqual([
      'ollama',
      'lmstudio',
      'litellm',
      'openai-compatible',
      'llamacpp',
      'anthropic',
      'openrouter',
      'ollama-cloud'
    ])
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

  it('exposes authentication and protocol capabilities consistently', () => {
    expect(providerDefinition('openrouter').capabilities.credentials).toBe('required')
    expect(providerDefinition('anthropic').protocol).toBe('anthropic')
    expect(providerDefinition('llamacpp').capabilities.discovery).toBe('manual')
    expect(providerDefinition('llamacpp').capabilities.health).toBe('openai-models')
    expect(providerDefinition('lmstudio').capabilities.modelLifecycle).toBe('none')
    expect(providerUsesOpenAIProtocol('openai-compatible')).toBe(true)
    expect(providerUsesOpenAIProtocol('litellm')).toBe(true)
    expect(providerUsesOpenAIProtocol('ollama')).toBe(false)
  })
})
