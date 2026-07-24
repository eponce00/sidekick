import { describe, expect, it, vi } from 'vitest'
import {
  completeUtilityChat,
  completeUtilityText,
  createUtilityModelConfig
} from './utilityCompletion'

function createApi() {
  return {
    providers: { complete: vi.fn() }
  }
}

describe('utilityCompletion', () => {
  it('routes Ollama chat calls and normalizes usage', async () => {
    const api = createApi()
    api.providers.complete.mockResolvedValue({
      ok: true,
      data: {
        message: { role: 'assistant', content: 'hello' },
        promptTokens: 12,
        completionTokens: 4,
        reasoningTokens: 0,
        finishReason: 'stop'
      }
    })

    const result = await completeUtilityText(
      {
        model: {
          provider: 'ollama',
          model: 'qwen',
          contextLength: 8192
        },
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 100,
        temperature: 0.2,
        purpose: 'title'
      },
      { api: api as never }
    )

    expect(result).toMatchObject({
      ok: true,
      text: 'hello',
      promptTokens: 12,
      completionTokens: 4,
      attempts: 1
    })
    expect(api.providers.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ providerKind: 'ollama', model: 'qwen' }),
        purpose: 'title'
      })
    )
  })

  it('routes all OpenAI-compatible instances through their configured endpoint', async () => {
    const api = createApi()
    api.providers.complete.mockResolvedValue({
      ok: true,
      data: {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: '1', function: { name: 'finish', arguments: '{"answer":"ok"}' } }]
        },
        promptTokens: 9,
        completionTokens: 3,
        reasoningTokens: 1,
        finishReason: 'tool_calls'
      }
    })

    const result = await completeUtilityChat(
      {
        model: {
          provider: 'lmstudio',
          providerKind: 'openai-compatible',
          model: 'local',
          providerInstanceId: 'development-server'
        },
        messages: [{ role: 'user', content: 'finish' }],
        tools: [{ type: 'function' }],
        purpose: 'research'
      },
      { api: api as never }
    )

    expect(result.message?.tool_calls?.[0].function.arguments).toEqual({ answer: 'ok' })
    expect(api.providers.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          providerKind: 'openai-compatible',
          providerInstanceId: 'development-server',
          model: 'local'
        })
      })
    )
  })

  it('normalizes authentication failures returned by the trusted runtime', async () => {
    const api = createApi()
    api.providers.complete.mockResolvedValue({
      ok: false,
      error: 'OpenRouter requires an API key'
    })
    const result = await completeUtilityChat(
      {
        model: {
          provider: 'openrouter',
          model: 'provider/model',
          providerInstanceId: 'openrouter'
        },
        messages: [{ role: 'user', content: 'hi' }],
        purpose: 'other'
      },
      { api: api as never }
    )

    expect(result.error).toMatchObject({ code: 'authentication', retryable: false })
    expect(api.providers.complete).toHaveBeenCalledOnce()
  })

  it('retries transient failures but not invalid requests', async () => {
    const api = createApi()
    api.providers.complete
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 503' })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          message: { role: 'assistant', content: 'recovered' },
          promptTokens: 1,
          completionTokens: 1,
          reasoningTokens: 0,
          finishReason: 'stop'
        }
      })
    const sleep = vi.fn(async () => undefined)

    const result = await completeUtilityText(
      {
        model: { provider: 'lmstudio', model: 'local', providerInstanceId: 'lm-studio' },
        messages: [{ role: 'user', content: 'hi' }],
        purpose: 'web-extraction'
      },
      { api: api as never, sleep }
    )

    expect(result).toMatchObject({ ok: true, text: 'recovered', attempts: 2 })
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('drops endpoints and credentials at the trusted runtime boundary', () => {
    expect(
      createUtilityModelConfig({
        provider: 'ollama-cloud',
        model: 'cloud-model'
      })
    ).toEqual({
      provider: 'ollama-cloud',
      providerKind: undefined,
      providerInstanceId: undefined,
      model: 'cloud-model',
      contextLength: undefined
    })
  })
})
