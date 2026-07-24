import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import { openAICompatibleHeaders } from './openAICompatibleClient'
import { discoverLiteLLMModels } from './liteLLMClient'

const endpoint = process.env.SIDEKICK_LITELLM_SMOKE_URL?.trim()
const apiKey = process.env.SIDEKICK_LITELLM_SMOKE_API_KEY
const smoke = endpoint ? describe : describe.skip

smoke('real LiteLLM proxy smoke', () => {
  it('discovers the virtual-key-visible model inventory without requiring admin routes', async () => {
    const instance: ProviderInstance = {
      id: 'litellm-smoke',
      name: 'LiteLLM smoke',
      type: 'litellm',
      enabled: true,
      baseUrl: endpoint!,
      apiKey,
      modelSource: 'discover',
      models: []
    }
    const result = await discoverLiteLLMModels(
      instance,
      openAICompatibleHeaders(apiKey),
      fetch,
      AbortSignal.timeout(30_000)
    )

    expect(result.ok, result.error).toBe(true)
    expect(result.data?.models.length).toBeGreaterThan(0)
    expect(result.data?.models.every((model) => Boolean(model.id))).toBe(true)
  }, 40_000)
})
