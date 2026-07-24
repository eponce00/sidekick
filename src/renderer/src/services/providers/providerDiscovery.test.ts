import { describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../../../shared/settings'
import { discoverProviderModels, testProviderConnection } from './providerDiscovery'

const instance = (updates: Partial<ProviderInstance>): ProviderInstance => ({
  id: 'provider-1',
  name: 'Provider',
  type: 'ollama',
  enabled: true,
  baseUrl: 'http://localhost:11434',
  modelSource: 'discover',
  models: [],
  ...updates
})

describe('provider discovery adapters', () => {
  it('discovers Ollama models and preserves visibility choices', async () => {
    const discoverModels = vi.fn(async () => ({
      ok: true,
      models: [
        { id: 'llava:latest', enabled: false },
        { id: 'qwen3:latest', enabled: true }
      ]
    }))
    const models = await discoverProviderModels(
      { providers: { discoverModels } } as unknown as Window['api'],
      instance({ models: [{ id: 'qwen3:latest', enabled: true }] })
    )

    expect(discoverModels).toHaveBeenCalledWith({
      draft: expect.objectContaining({ id: 'provider-1', type: 'ollama' })
    })
    expect(models).toEqual([
      expect.objectContaining({ id: 'llava:latest', enabled: false, supportsVision: true }),
      expect.objectContaining({ id: 'qwen3:latest', enabled: true })
    ])
  })

  it('retains context metadata returned by OpenAI-compatible catalogs', async () => {
    const discoverModels = vi.fn(async () => ({
      ok: true,
      models: [{ id: 'local-model', enabled: false, contextLength: 65_536 }]
    }))
    const models = await discoverProviderModels(
      { providers: { discoverModels } } as unknown as Window['api'],
      instance({
        type: 'openai-compatible',
        preset: 'generic',
        baseUrl: 'https://example.test/v1'
      })
    )

    expect(models[0]).toMatchObject({ id: 'local-model', contextLength: 65_536 })
  })

  it('health-checks manual llama.cpp instances without changing their model inventory', async () => {
    const discoverModels = vi.fn(async () => ({ ok: true, models: [] }))
    await testProviderConnection(
      { providers: { discoverModels } } as unknown as Window['api'],
      instance({
        type: 'llamacpp',
        baseUrl: 'http://localhost:8080/v1',
        modelSource: 'manual'
      })
    )

    expect(discoverModels).toHaveBeenCalledWith({
      draft: expect.objectContaining({
        type: 'llamacpp',
        baseUrl: 'http://localhost:8080/v1',
        modelSource: 'manual'
      })
    })
  })
})
