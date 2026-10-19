import { describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import { discoverAnthropicModels } from './anthropicClient'
import { discoverOllamaModels, resolveOllamaContext } from './ollamaClient'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function instance(
  type: ProviderInstance['type'],
  baseUrl: string,
  models: ProviderInstance['models'] = []
): ProviderInstance {
  return { id: type, name: type, type, enabled: true, baseUrl, modelSource: 'discover', models }
}

describe('discoverAnthropicModels', () => {
  it('reads each model’s limits and capabilities and follows every page', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const after = new URL(String(url)).searchParams.get('after_id')
      return after === 'claude-opus-5-5'
        ? json({
            data: [
              {
                id: 'claude-haiku-4-5',
                display_name: 'Claude Haiku 4.5',
                lifecycle: 'active',
                max_input_tokens: 200_000,
                max_tokens: 64_000,
                capabilities: {
                  image_input: { supported: true },
                  pdf_input: { supported: true },
                  thinking: { supported: true }
                }
              },
              { id: 'claude-2', lifecycle: 'retired' }
            ],
            has_more: false,
            last_id: 'claude-2'
          })
        : json({
            data: [
              {
                id: 'claude-opus-5-5',
                display_name: 'Claude Opus 5.5',
                lifecycle: 'active',
                max_input_tokens: 1_000_000,
                max_tokens: 128_000,
                capabilities: {
                  image_input: { supported: true },
                  pdf_input: { supported: true },
                  thinking: { supported: true }
                }
              }
            ],
            has_more: true,
            last_id: 'claude-opus-5-5'
          })
    })
    const result = await discoverAnthropicModels(
      instance('anthropic', 'https://api.anthropic.com/v1', [
        { id: 'claude-opus-5-5', name: 'claude-opus-5-5', enabled: true }
      ]),
      fetchImpl
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.anthropic.com/v1/models?limit=1000'
    )
    expect(result.models).toEqual([
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        enabled: false,
        contextLength: 200_000,
        outputTokenLimit: 64_000,
        supportsVision: true,
        supportsPdfInput: true,
        supportsReasoning: true,
        supportsTools: true,
        metadataSource: 'provider'
      },
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        enabled: true,
        contextLength: 1_000_000,
        outputTokenLimit: 128_000,
        supportsVision: true,
        supportsPdfInput: true,
        supportsReasoning: true,
        supportsTools: true,
        metadataSource: 'provider'
      }
    ])
  })

  it('leaves the context unknown when the API does not report it, rather than guessing', async () => {
    const result = await discoverAnthropicModels(
      instance('anthropic', 'https://gateway.test/v1'),
      vi.fn(async () => json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }))
    )
    expect(result.models?.[0]).toMatchObject({ id: 'claude-x', metadataSource: 'unknown' })
    expect(result.models?.[0].contextLength).toBeUndefined()
  })
})

describe('discoverOllamaModels', () => {
  const show: Record<string, unknown> = {
    'qwen3:8b': {
      capabilities: ['completion', 'tools', 'thinking'],
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 }
    },
    'gemma3:4b': {
      capabilities: ['completion', 'vision'],
      model_info: { 'gemma3.context_length': 131_072 }
    },
    'nomic-embed-text:latest': {
      capabilities: ['embedding'],
      model_info: { 'nomic-bert.context_length': 2048 }
    }
  }

  const server = (tags: string[]) =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return json({ models: tags.map((name) => ({ name, model: name })) })
      }
      const { model } = JSON.parse(String(init?.body)) as { model: string }
      return model in show ? json(show[model]) : json({ error: 'not found' }, 404)
    })

  it('reads what each model can do and leaves out embedding models', async () => {
    const fetchImpl = server(['qwen3:8b', 'gemma3:4b', 'nomic-embed-text:latest'])
    const result = await discoverOllamaModels(
      instance('ollama', 'http://localhost:11434', [
        {
          id: 'qwen3:8b',
          enabled: true,
          metadataOverrides: { contextLength: 16_384 }
        }
      ]),
      fetchImpl
    )
    expect(result.models).toEqual([
      {
        id: 'gemma3:4b',
        name: 'gemma3:4b',
        enabled: false,
        contextLength: 131_072,
        supportsTools: false,
        supportsVision: true,
        supportsReasoning: false,
        metadataSource: 'provider'
      },
      {
        id: 'qwen3:8b',
        name: 'qwen3:8b',
        enabled: true,
        contextLength: 16_384,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        metadataOverrides: { contextLength: 16_384 },
        metadataSource: 'configured'
      }
    ])
  })

  it('still lists a model whose details cannot be read', async () => {
    const result = await discoverOllamaModels(
      instance('ollama-cloud', 'https://ollama.com'),
      server(['mystery:latest'])
    )
    expect(result.models).toEqual([
      { id: 'mystery:latest', name: 'mystery:latest', enabled: false, metadataSource: 'unknown' }
    ])
  })

  it('resolves a model’s context from the same details', async () => {
    const fetchImpl = server([])
    await expect(
      resolveOllamaContext(instance('ollama', 'http://localhost:11434'), 'gemma3:4b', fetchImpl)
    ).resolves.toBe(131_072)
    await expect(
      resolveOllamaContext(instance('ollama', 'http://localhost:11434'), 'missing', fetchImpl)
    ).resolves.toBeUndefined()
  })
})
