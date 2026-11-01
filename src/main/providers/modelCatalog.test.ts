import { describe, expect, it, vi } from 'vitest'
import {
  applyProviderModelOverrides,
  fetchLMStudioModelDetails,
  isChatModelMode,
  lmStudioModelChats,
  normalizeOpenRouterModel,
  openRouterModelChats,
  withLMStudioDetails
} from './modelCatalog'

describe('normalizeOpenRouterModel', () => {
  it('reads limits, capabilities, and prices from the catalog fields', () => {
    expect(
      normalizeOpenRouterModel({
        id: 'anthropic/claude-sonnet-5',
        name: 'Anthropic: Claude Sonnet 5',
        context_length: 1_000_000,
        top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
        architecture: {
          modality: 'text+image+file->text',
          input_modalities: ['text', 'image', 'file'],
          output_modalities: ['text']
        },
        supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'reasoning'],
        pricing: { prompt: '0.000003', completion: '0.000015' }
      })
    ).toEqual({
      id: 'anthropic/claude-sonnet-5',
      name: 'Anthropic: Claude Sonnet 5',
      enabled: false,
      contextLength: 1_000_000,
      outputTokenLimit: 64_000,
      supportsTools: true,
      supportsReasoning: true,
      supportsVision: true,
      supportsPdfInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      pricing: { prompt: 0.000003, completion: 0.000015 },
      metadataSource: 'provider'
    })
  })

  it('says a model takes no tools only when the catalog lists its parameters', () => {
    const listed = normalizeOpenRouterModel({ id: 'a', supported_parameters: ['max_tokens'] })
    expect(listed.supportsTools).toBe(false)
    expect(listed.supportsReasoning).toBe(false)
    const unlisted = normalizeOpenRouterModel({ id: 'b' })
    expect(unlisted.supportsTools).toBeUndefined()
    expect(unlisted.metadataSource).toBe('unknown')
  })

  it('falls back to the older modality string and drops a router price it cannot read', () => {
    const model = normalizeOpenRouterModel({
      id: 'openrouter/auto',
      architecture: { modality: 'text+image->text' },
      pricing: { prompt: '-1', completion: '-1' }
    })
    expect(model.supportsVision).toBe(true)
    expect(model.supportsAudioInput).toBe(false)
    expect(model.pricing).toBeUndefined()
  })

  it('leaves out models that cannot write text', () => {
    expect(
      openRouterModelChats({ id: 'image', architecture: { output_modalities: ['image'] } })
    ).toBe(false)
    expect(
      openRouterModelChats({ id: 'both', architecture: { output_modalities: ['text', 'image'] } })
    ).toBe(true)
    expect(openRouterModelChats({ id: 'older' })).toBe(true)
  })
})

describe('isChatModelMode', () => {
  it('keeps chat models and models without a mode, and leaves out the rest', () => {
    expect(isChatModelMode('chat')).toBe(true)
    expect(isChatModelMode(undefined)).toBe(true)
    expect(isChatModelMode('embedding')).toBe(false)
    expect(isChatModelMode('image_generation')).toBe(false)
    expect(isChatModelMode('rerank')).toBe(false)
  })
})

describe('LM Studio details', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('reads the newer model list, keyed by model key', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/api/v1/models')
        ? json({
            models: [
              {
                type: 'llm',
                key: 'google/gemma-4-26b-a4b',
                display_name: 'Gemma 4 26B A4B',
                max_context_length: 262_144,
                capabilities: {
                  vision: true,
                  trained_for_tool_use: true,
                  reasoning: { allowed_options: ['off', 'on'], default: 'on' }
                }
              },
              { type: 'embedding', key: 'text-embedding-nomic', max_context_length: 2048 }
            ]
          })
        : json({}, 404)
    )
    const details = await fetchLMStudioModelDetails('http://localhost:1234/v1', {}, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:1234/api/v1/models', {
      headers: {},
      signal: undefined
    })
    expect(lmStudioModelChats(details.get('text-embedding-nomic'))).toBe(false)
    expect(
      withLMStudioDetails(
        { id: 'google/gemma-4-26b-a4b', name: 'google/gemma-4-26b-a4b', enabled: false },
        details.get('google/gemma-4-26b-a4b')
      )
    ).toEqual({
      id: 'google/gemma-4-26b-a4b',
      name: 'Gemma 4 26B A4B',
      enabled: false,
      contextLength: 262_144,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      reasoningLevels: ['off', 'on'],
      reasoningDefault: 'on',
      metadataSource: 'provider'
    })
  })

  it('falls back to the older model list on a server without the newer one', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/api/v0/models')
        ? json({
            data: [
              { id: 'qwen2-vl-7b-instruct', type: 'vlm', max_context_length: 32_768 },
              { id: 'nomic-embed', type: 'embeddings' }
            ]
          })
        : json({ error: 'Unexpected endpoint' }, 404)
    )
    const details = await fetchLMStudioModelDetails('http://localhost:1234/v1', {}, fetchImpl)
    expect(lmStudioModelChats(details.get('nomic-embed'))).toBe(false)
    const model = withLMStudioDetails(
      { id: 'qwen2-vl-7b-instruct', enabled: false },
      details.get('qwen2-vl-7b-instruct')
    )
    expect(model.contextLength).toBe(32_768)
    expect(model.supportsVision).toBe(true)
  })

  it('leaves a model as it is when LM Studio has no details for it', async () => {
    const details = await fetchLMStudioModelDetails(
      'http://localhost:1234/v1',
      {},
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(details.size).toBe(0)
    expect(lmStudioModelChats(undefined)).toBe(true)
    const model = { id: 'local', enabled: false }
    expect(withLMStudioDetails(model, undefined)).toBe(model)
  })
})

describe('applyProviderModelOverrides', () => {
  it('takes the provider name over a name that only repeats the id', () => {
    const discovered = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: false }
    expect(
      applyProviderModelOverrides(discovered, {
        id: 'claude-opus-5-5',
        name: 'claude-opus-5-5',
        enabled: true
      })
    ).toMatchObject({ name: 'Claude Opus 5.5', enabled: true })
    expect(
      applyProviderModelOverrides(discovered, {
        id: 'claude-opus-5-5',
        name: 'Opus',
        enabled: true
      }).name
    ).toBe('Opus')
  })
})
