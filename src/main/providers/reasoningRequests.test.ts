import { describe, expect, it, vi } from 'vitest'
import type { ProviderChatRequest } from '../../shared/providerRuntime'
import type { ProviderInstance } from '../../shared/settings'
import type { ReasoningLevel } from '../../shared/reasoning'
import type { ProviderKind } from '../../shared/providerRegistry'
import { completeAnthropicChat } from './anthropicClient'
import { completeOllamaChat } from './ollamaClient'
import {
  executeOpenAICompatibleWithReasoningFallback,
  openAIRequest,
  withReasoningRetry
} from './providerRuntime'

function request(
  providerKind: ProviderKind,
  model: string,
  reasoningLevel?: ReasoningLevel
): ProviderChatRequest {
  return {
    target: { providerKind, model },
    messages: [{ role: 'user', content: 'Hello' }],
    reasoningLevel,
    maxOutputTokens: 20_000,
    temperature: 0.2,
    purpose: 'conversation'
  }
}

describe('OpenAI-compatible reasoning fields', () => {
  it('sends nothing for a model with no level to choose', () => {
    for (const kind of ['openrouter', 'litellm', 'lmstudio', 'llamacpp'] as const) {
      const body = openAIRequest(request(kind, 'm'))
      expect(body).not.toHaveProperty('reasoning')
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('chat_template_kwargs')
    }
  })

  it('carries each level in the form each server reads', () => {
    expect(openAIRequest(request('openrouter', 'openai/o3', 'xhigh'))).toMatchObject({
      reasoning: { effort: 'xhigh' }
    })
    expect(openAIRequest(request('openrouter', 'openai/o3', 'off'))).toMatchObject({
      reasoning: { effort: 'none' }
    })
    // A model that reasons without effort levels only switches on.
    expect(openAIRequest(request('openrouter', 'qwen/qwen3', 'on'))).toMatchObject({
      reasoning: { enabled: true }
    })
    expect(openAIRequest(request('litellm', 'gpt-5', 'minimal'))).toMatchObject({
      reasoning_effort: 'minimal'
    })
    // LM Studio speaks the plain OpenAI scale.
    expect(openAIRequest(request('lmstudio', 'qwen', 'xhigh'))).toMatchObject({
      reasoning_effort: 'high'
    })
    expect(openAIRequest(request('lmstudio', 'gemma', 'on'))).toMatchObject({
      reasoning_effort: 'medium'
    })
    // llama.cpp reads `reasoning_effort` in templates that use it and `enable_thinking` in others.
    expect(openAIRequest(request('llamacpp', 'qwen', 'off'))).toMatchObject({
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false }
    })
    expect(openAIRequest(request('llamacpp', 'gpt-oss', 'low'))).toMatchObject({
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: true }
    })
    expect(openAIRequest(request('openai-compatible', 'qwen', 'low'))).toMatchObject({
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: true }
    })
  })

  it('retries once with the model default when a server rejects the fields', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Unrecognized request argument: reasoning_effort'
      })
      .mockResolvedValueOnce({ ok: true })
    await executeOpenAICompatibleWithReasoningFallback(
      request('openai-compatible', 'qwen', 'high'),
      execute
    )
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][0]).not.toHaveProperty('reasoning_effort')
    expect(execute.mock.calls[1][0]).not.toHaveProperty('chat_template_kwargs')
  })

  it('does not retry a request that carried no reasoning fields', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: 'reasoning model overloaded' })
    await executeOpenAICompatibleWithReasoningFallback(request('lmstudio', 'qwen'), execute)
    expect(execute).toHaveBeenCalledOnce()
  })
})

function capture(): {
  fetch: typeof fetch
  sent: () => { headers: Record<string, string>; body: Record<string, unknown> }
} {
  let init: RequestInit | undefined
  const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
    init = options
    return new Response(JSON.stringify({ content: [], message: { content: '' } }), {
      status: 200
    })
  }) as unknown as typeof fetch
  return {
    fetch: fetchImpl,
    sent: () => ({
      headers: init!.headers as Record<string, string>,
      body: JSON.parse(init!.body as string)
    })
  }
}

const anthropic: ProviderInstance = {
  id: 'anthropic',
  name: 'Anthropic',
  type: 'anthropic',
  enabled: true,
  baseUrl: 'https://fixture.invalid',
  modelSource: 'discover',
  models: []
}
const ollama: ProviderInstance = { ...anthropic, id: 'ollama', name: 'Ollama', type: 'ollama' }

describe('Anthropic reasoning', () => {
  it('sends adaptive thinking with an effort level to models that take one', async () => {
    const { fetch, sent } = capture()
    await completeAnthropicChat(anthropic, request('anthropic', 'claude-opus-4-6', 'max'), fetch)
    expect(sent().body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' }
    })
    expect(sent().body).not.toHaveProperty('temperature')
    expect(sent().headers['anthropic-beta']).toContain('effort-2025-11-24')
  })

  it('gives older models a thinking budget for the level', async () => {
    const { fetch, sent } = capture()
    await completeAnthropicChat(anthropic, request('anthropic', 'claude-3-7-sonnet', 'low'), fetch)
    expect(sent().body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2048 } })
    expect(sent().body).not.toHaveProperty('output_config')
  })

  it('keeps temperature and sends no thinking when reasoning is off', async () => {
    const { fetch, sent } = capture()
    await completeAnthropicChat(anthropic, request('anthropic', 'claude-opus-4-6', 'off'), fetch)
    expect(sent().body).not.toHaveProperty('thinking')
    expect(sent().body).toMatchObject({ temperature: 0.2 })
    expect(sent().headers).not.toHaveProperty('anthropic-beta')
  })
})

describe('Ollama reasoning', () => {
  it('sends think as a switch, or as a level for a model that takes levels', async () => {
    const cases: Array<[string, ReasoningLevel, unknown]> = [
      ['qwen3:8b', 'off', false],
      ['qwen3:8b', 'on', true],
      ['gpt-oss:20b', 'high', 'high'],
      ['gpt-oss:20b', 'xhigh', 'high']
    ]
    for (const [model, level, think] of cases) {
      const { fetch, sent } = capture()
      await completeOllamaChat(ollama, request('ollama', model, level), fetch)
      expect(sent().body.think, `${model} ${level}`).toEqual(think)
    }
    // No level leaves the model's own default.
    const { fetch, sent } = capture()
    await completeOllamaChat(ollama, request('ollama', 'llama3'), fetch)
    expect(sent().body).not.toHaveProperty('think')
  })
})

describe('withReasoningRetry', () => {
  it('drops a rejected level to the model default', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: '"qwen2" does not support thinking' })
      .mockResolvedValueOnce({ ok: true })
    await withReasoningRetry(request('ollama', 'qwen2', 'on'), run)
    expect(run.mock.calls[1][0].reasoningLevel).toBeUndefined()
  })

  it('keeps Anthropic thinking adaptively when only the effort is rejected', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'output_config.effort: Extra inputs are not permitted'
      })
      .mockResolvedValueOnce({ ok: true })
    await withReasoningRetry(request('anthropic', 'claude-opus-4-6', 'high'), run)
    expect(run.mock.calls[1][0].reasoningLevel).toBe('on')
  })

  it('leaves unrelated failures alone', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, error: 'Invalid API key' })
    await withReasoningRetry(request('anthropic', 'claude-opus-4-6', 'high'), run)
    expect(run).toHaveBeenCalledOnce()
  })
})
