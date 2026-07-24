import { describe, expect, it } from 'vitest'
import type { ProviderSettings } from './settings'
import {
  migrateLegacyProviderInstances,
  pinnedModelsFromProviderInstances,
  providerInstanceForModel,
  refreshProviderTargetMetadata,
  syncLegacyProviderSettings
} from './providerInstances'

const legacySettings: ProviderSettings = {
  openRouterApiKey: '',
  ollamaEndpoint: 'http://localhost:11434',
  lmStudioEndpoint: 'https://example.test/v1',
  lmStudioApiKey: 'secret',
  llamaCppEndpoint: 'http://localhost:8080/v1'
}

describe('provider instance migration', () => {
  it('migrates only providers that were actually configured or used', () => {
    const instances = migrateLegacyProviderInstances(legacySettings, [
      { id: 'lmstudio:model-a', name: 'model-a', provider: 'lmstudio' }
    ])

    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({
      id: 'lm-studio',
      type: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret'
    })
    expect(instances[0].models[0]).toMatchObject({ id: 'model-a', enabled: true })
  })

  it('creates stable instance-scoped model ids for the chat picker', () => {
    const [instance] = migrateLegacyProviderInstances(legacySettings, [
      { id: 'lmstudio:model-a', name: 'model-a', provider: 'lmstudio' }
    ])
    instance.health = { status: 'online', checkedAt: 123 }
    const models = pinnedModelsFromProviderInstances([instance])

    expect(models[0]).toMatchObject({
      id: 'lmstudio:lm-studio/model-a',
      providerKind: 'lmstudio',
      providerInstanceId: 'lm-studio',
      providerModelId: 'model-a',
      providerHealth: { status: 'online', checkedAt: 123 }
    })
    expect(
      providerInstanceForModel({ ...legacySettings, providerInstances: [instance] }, models[0])
    ).toBe(instance)
  })

  it('keeps legacy runtime fields synchronized during the transition', () => {
    const synchronized = syncLegacyProviderSettings({
      ...legacySettings,
      providerInstances: [
        {
          id: 'custom',
          name: 'Custom',
          type: 'openai-compatible',
          enabled: true,
          baseUrl: 'https://new.example/v1',
          apiKey: 'new-secret',
          modelSource: 'discover',
          models: []
        }
      ]
    })

    expect(synchronized.lmStudioEndpoint).toBe('https://new.example/v1')
    expect(synchronized.lmStudioApiKey).toBe('')
  })

  it('preserves LiteLLM capability metadata in chat model entries', () => {
    const models = pinnedModelsFromProviderInstances([
      {
        id: 'home-gateway',
        name: 'Home gateway',
        type: 'litellm',
        enabled: true,
        baseUrl: 'https://gateway.test/v1',
        modelSource: 'discover',
        models: [
          {
            id: 'coding',
            enabled: true,
            contextLength: 128_000,
            maxOutputTokens: 16_000,
            supportsTools: true,
            supportsReasoning: true,
            editingDialect: 'auto',
            upstreamModel: 'openai/gpt-5.4-codex',
            editingCalibration: {
              version: 2,
              model: 'coding',
              upstreamModel: 'openai/gpt-5.4-codex',
              selectedDialect: 'apply-patch',
              verifiedDialects: ['apply-patch'],
              results: [],
              calibratedAt: 1,
              source: 'active-probe'
            }
          }
        ]
      }
    ])

    expect(models[0]).toMatchObject({
      id: 'litellm:home-gateway/coding',
      provider: 'litellm',
      providerKind: 'litellm',
      contextLength: 128_000,
      maxOutputTokens: 16_000,
      supportsTools: true,
      supportsReasoning: true,
      editingDialect: 'auto',
      upstreamModel: 'openai/gpt-5.4-codex',
      editingCalibration: expect.objectContaining({ selectedDialect: 'apply-patch' })
    })
  })

  it('refreshes a persisted collaboration target from current model overrides', () => {
    expect(
      refreshProviderTargetMetadata(
        {
          providerInstanceId: 'home-gateway',
          providerKind: 'litellm',
          model: 'local-loaded-model',
          contextLength: 32_768,
          maxOutputTokens: 16_384
        },
        [
          {
            id: 'home-gateway',
            name: 'Home gateway',
            type: 'litellm',
            enabled: true,
            baseUrl: 'https://gateway.test/v1',
            modelSource: 'discover',
            models: [
              {
                id: 'local-loaded-model',
                enabled: true,
                contextLength: 32_768,
                maxOutputTokens: 16_384,
                editingDialect: 'structured-edit',
                metadataOverrides: { contextLength: 180_000, maxOutputTokens: 32_000 }
              }
            ]
          }
        ]
      )
    ).toMatchObject({
      contextLength: 180_000,
      maxOutputTokens: 32_000,
      editingDialect: 'structured-edit'
    })
  })
})
