import { describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import {
  applyProviderModelOverrides,
  discoverLiteLLMModels,
  normalizeOpenAIModelMetadata
} from './liteLLMClient'
import { openAICompatibleHeaders } from './openAICompatibleClient'

function instance(models: ProviderInstance['models'] = []): ProviderInstance {
  return {
    id: 'litellm-home',
    name: 'Home LiteLLM',
    type: 'litellm',
    enabled: true,
    baseUrl: 'https://gateway.test/v1',
    apiKey: 'virtual-key',
    modelSource: 'discover',
    models
  }
}

describe('LiteLLM provider discovery', () => {
  it('reads context and capabilities directly from modern /models responses', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'fast-model',
                max_input_tokens: 131_072,
                max_output_tokens: 16_384,
                input_cost_per_token: '0.000001',
                output_cost_per_token: '0.000002',
                supports_function_calling: true,
                supports_vision: false,
                supports_reasoning: true
              }
            ]
          })
        )
      }
      return new Response(JSON.stringify({ error: 'not allowed' }), { status: 403 })
    })

    const result = await discoverLiteLLMModels(
      instance(),
      openAICompatibleHeaders('virtual-key'),
      fetchImpl as typeof fetch
    )

    expect(result.data?.models).toEqual([
      expect.objectContaining({
        id: 'fast-model',
        contextLength: 131_072,
        maxInputTokens: 131_072,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        pricing: { prompt: 0.000001, completion: 0.000002 },
        metadataSource: 'provider'
      })
    ])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer virtual-key' })
      })
    )
  })

  it('enriches aliases from LiteLLM model group metadata when the key can access it', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'coding' }] }))
      }
      if (path === 'https://gateway.test/v1/model_group/info') {
        return new Response(
          JSON.stringify({
            data: [
              {
                model_group: 'coding',
                litellm_params: { model: 'openai/gpt-5.4-codex' },
                max_input_tokens: 200_000,
                max_output_tokens: 32_000,
                supports_function_calling: true,
                supports_vision: true,
                supported_openai_params: ['tools', 'response_format']
              }
            ]
          })
        )
      }
      return new Response('', { status: 404 })
    })

    const result = await discoverLiteLLMModels(
      instance(),
      openAICompatibleHeaders(),
      fetchImpl as typeof fetch
    )

    expect(result.data?.models[0]).toMatchObject({
      id: 'coding',
      contextLength: 200_000,
      maxOutputTokens: 32_000,
      supportsTools: true,
      supportsVision: true,
      upstreamModel: 'openai/gpt-5.4-codex',
      metadataSource: 'provider'
    })
  })

  it('keeps model discovery usable when privileged metadata routes are forbidden', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'private-model' }] }))
      }
      return new Response(JSON.stringify({ error: 'Virtual key is not allowed' }), { status: 403 })
    })

    const result = await discoverLiteLLMModels(
      instance(),
      openAICompatibleHeaders('virtual-key'),
      fetchImpl as typeof fetch
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        models: [
          {
            id: 'private-model',
            enabled: false,
            metadataSource: 'unknown'
          }
        ]
      }
    })
  })

  it('preserves visibility and explicit manual overrides across refreshes', () => {
    const discovered = normalizeOpenAIModelMetadata({
      id: 'coding',
      max_input_tokens: 64_000,
      supports_function_calling: false
    })
    const merged = applyProviderModelOverrides(discovered, {
      id: 'coding',
      enabled: true,
      contextLength: 128_000,
      supportsTools: true,
      metadataOverrides: { contextLength: 128_000, supportsTools: true }
    })

    expect(merged).toMatchObject({
      enabled: true,
      contextLength: 128_000,
      maxInputTokens: 64_000,
      supportsTools: true,
      metadataSource: 'configured',
      metadataOverrides: { contextLength: 128_000, supportsTools: true }
    })
  })

  it('parses common metadata for generic OpenAI-compatible catalogs too', () => {
    expect(
      normalizeOpenAIModelMetadata({
        id: 'generic',
        max_model_len: 32_768,
        max_output_tokens: 4_096,
        supported_openai_params: ['tools']
      })
    ).toMatchObject({
      contextLength: 32_768,
      maxInputTokens: 32_768,
      maxOutputTokens: 4_096,
      supportsTools: true,
      metadataSource: 'provider'
    })
  })
})
