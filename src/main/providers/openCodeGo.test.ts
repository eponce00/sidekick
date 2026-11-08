import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInstance } from '../../shared/settings'
import type { OpenAICompatibleModel } from './openAICompatibleClient'
import {
  discoverOpenCodeGoModels,
  normalizeOpenCodeGoModel,
  openCodeGoEndpoints,
  openCodeGoHeaders
} from './openCodeGo'
import {
  completeProviderChat,
  discoverProviderModels,
  resolveProviderContext,
  streamProviderChat
} from './providerRuntime'

const configured = vi.hoisted(() => ({ instance: undefined as ProviderInstance | undefined }))
vi.mock('./providerResolver', () => ({
  resolveProviderInstance: () => configured.instance,
  resolveProviderInstanceById: () => configured.instance,
  resolveProviderDraft: (instance: ProviderInstance) => instance,
  requireProviderApiKey: (instance: ProviderInstance) => instance.apiKey
}))

const instance: ProviderInstance = {
  id: 'go',
  name: 'OpenCode Go',
  type: 'openai-compatible',
  preset: 'generic',
  enabled: true,
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  apiKey: 'fixture-key',
  modelSource: 'discover',
  models: []
}
const model = {
  id: 'go-model',
  name: 'Go model',
  type: 'chat',
  limit: { context: 262144, input: 240000, output: 65536 },
  capabilities: {
    tools: { supported: true },
    reasoning: { supported: true, effort: ['low', 'high', 'max'] }
  },
  modalities: { input: ['text', 'image/png', 'application/pdf'], output: ['text'] },
  cost: { text: { input: { price: 0.5 }, output: { price: 2 } } }
}
const request = {
  conversationId: 'chat-a',
  target: {
    providerInstanceId: 'go',
    providerKind: 'openai-compatible' as const,
    model: 'go-model'
  },
  purpose: 'conversation' as const,
  messages: [{ role: 'user', content: 'hello' }],
  reasoningLevel: 'max' as const
}
afterEach(() => {
  vi.unstubAllGlobals()
  configured.instance = undefined
})

describe('OpenCode Go through the OpenAI-compatible provider', () => {
  it.each([
    '/inference/go',
    '/inference/go/v1/',
    '/inference/go/openai/v1',
    '/inference/go/openai/v1/chat/completions'
  ])('uses only the Go catalog and chat routes for %s', (path) => {
    expect(openCodeGoEndpoints({ ...instance, baseUrl: `https://opencode.ai${path}` })).toEqual({
      chat: 'https://opencode.ai/inference/go/openai/v1',
      catalog: 'https://opencode.ai/inference/go/v1'
    })
  })
  it.each([
    'https://opencode.ai/inference/openai/v1',
    'https://opencode.ai.evil.test/inference/go/openai/v1',
    'http://opencode.ai/inference/go/openai/v1',
    'https://opencode.ai:444/inference/go/openai/v1',
    'https://user:pass@opencode.ai/inference/go/openai/v1',
    'https://opencode.ai/inference/go/openai/v1?next=https://evil.test',
    'https://opencode.ai/inference/go/openai/v1#other',
    'https://other.test/inference/go/openai/v1'
  ])('does not rewrite or identify an unrelated endpoint: %s', (baseUrl) => {
    expect(openCodeGoEndpoints({ ...instance, baseUrl })).toBeUndefined()
  })
  it('reads limits, capabilities, supported efforts and per-token prices from the catalog', () => {
    expect(normalizeOpenCodeGoModel(model)).toMatchObject({
      id: 'go-model',
      contextLength: 262144,
      maxInputTokens: 240000,
      outputTokenLimit: 65536,
      supportsTools: true,
      supportsVision: true,
      supportsPdfInput: true,
      supportsReasoning: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      reasoningLevels: ['low', 'high', 'max'],
      pricing: { prompt: 0.5 / 1000000, completion: 2 / 1000000 },
      metadataSource: 'provider'
    })
    expect(normalizeOpenCodeGoModel(model).maxOutputTokens).toBeUndefined()
    expect(normalizeOpenCodeGoModel({ id: 'unknown' }).metadataSource).toBe('unknown')
    expect(normalizeOpenCodeGoModel({ id: 'unknown' }).supportsTools).toBeUndefined()
  })
  it('keeps false capabilities and refuses malformed limits or invented effort levels', () => {
    const malformed = {
      id: 'plain',
      limit: { context: -1, output: 'invalid' },
      capabilities: {
        tools: { supported: false },
        reasoning: { supported: false, effort: ['invented'] }
      },
      modalities: { input: ['text'], output: ['text'] }
    } as unknown as OpenAICompatibleModel
    expect(normalizeOpenCodeGoModel(malformed)).toMatchObject({
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      reasoningLevels: []
    })
    expect(normalizeOpenCodeGoModel(malformed).contextLength).toBeUndefined()
    expect(normalizeOpenCodeGoModel(malformed).outputTokenLimit).toBeUndefined()
  })
  it('maps none to Off and reads a structured default without inventing effort controls', () => {
    const withReasoning = (reasoning: unknown) =>
      normalizeOpenCodeGoModel({
        id: 'reasoner',
        capabilities: { reasoning }
      } as unknown as OpenAICompatibleModel)
    expect(
      withReasoning({
        supported: true,
        effort: ['none', 'low', 'max'],
        default: { type: 'effort', value: 'max' }
      })
    ).toMatchObject({ reasoningLevels: ['off', 'low', 'max'], reasoningDefault: 'max' })
    expect(withReasoning({ supported: true }).reasoningLevels).toEqual([])
  })
  it('uses stable opaque sessions per chat, including arbitrary input safe for headers', () => {
    expect(openCodeGoHeaders('chat-a')).toEqual(openCodeGoHeaders('chat-a'))
    expect(openCodeGoHeaders('chat-a')).not.toEqual(openCodeGoHeaders('chat-b'))
    expect(openCodeGoHeaders('chat-a')['x-opencode-session']).not.toContain('chat-a')
    expect(openCodeGoHeaders('chat\r\ninjected: value')['x-opencode-session']).toMatch(
      /^ses_[a-f0-9]{64}$/
    )
    expect(openCodeGoHeaders()['x-opencode-session']).not.toBe(
      openCodeGoHeaders()['x-opencode-session']
    )
  })
  it('fetches the dedicated catalog, preserves overrides, and discovers context for an existing saved connection', async () => {
    configured.instance = {
      ...instance,
      models: [{ id: 'go-model', enabled: true, metadataOverrides: { supportsVision: false } }]
    }
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        data: [model, { id: 'embed', type: 'embedding' }, null, { id: 4 }, { id: '' }]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await discoverProviderModels({ providerInstanceId: 'go' })
    expect(result.models).toHaveLength(1)
    expect(result.models?.[0]).toMatchObject({
      contextLength: 262144,
      supportsVision: false,
      metadataSource: 'configured'
    })
    expect(await resolveProviderContext(request.target)).toMatchObject({
      contextLength: 262144,
      reliable: true,
      source: 'provider'
    })
    expect(
      fetchMock.mock.calls.every(([url]) => url === 'https://opencode.ai/inference/go/v1/models')
    ).toBe(true)
  })
  it('passes cancellation to catalog discovery without following URLs supplied by the catalog', async () => {
    const signal = new AbortController().signal
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ ...model, api: { 'chat-completions': { base_url: 'https://evil.test' } } }]
      })
    )
    await discoverOpenCodeGoModels(instance, {}, fetchMock, signal)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/inference/go/v1/models', {
      headers: {},
      signal
    })
  })
  it('keeps unrelated OpenAI-compatible providers on their configured endpoint without Go headers', async () => {
    configured.instance = { ...instance, baseUrl: 'https://other.test/v1' }
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect((await completeProviderChat(request)).ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://other.test/v1/chat/completions')
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers).not.toHaveProperty('x-opencode-session')
    expect(headers).not.toHaveProperty('User-Agent')
  })
  it('keeps the session across streams, titles, compaction and reasoning retries', async () => {
    configured.instance = instance
    const calls: Array<{
      url: string
      headers: Record<string, string>
      body: Record<string, unknown>
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        calls.push({ url, body, headers: init.headers as Record<string, string> })
        if (calls.length === 1)
          return Response.json(
            { error: { message: 'Unsupported reasoning_effort' } },
            { status: 400 }
          )
        if (body.stream)
          return new Response(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'
          )
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }]
        })
      })
    )
    expect((await streamProviderChat(request, () => undefined)).ok).toBe(true)
    for (const purpose of ['title', 'compaction'] as const)
      expect((await completeProviderChat({ ...request, purpose })).ok).toBe(true)
    expect(calls).toHaveLength(4)
    expect(new Set(calls.map(({ headers }) => headers['x-opencode-session'])).size).toBe(1)
    expect(
      calls.every(
        ({ url }) => url === 'https://opencode.ai/inference/go/openai/v1/chat/completions'
      )
    ).toBe(true)
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer fixture-key',
      'User-Agent': expect.stringMatching(/^SideKick\//)
    })
    expect(calls[0].body.reasoning_effort).toBe('max')
    expect(calls[0].body).not.toHaveProperty('chat_template_kwargs')
    expect(calls[1].body).not.toHaveProperty('reasoning_effort')
  })
})
