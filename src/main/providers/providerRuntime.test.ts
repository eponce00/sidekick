import { describe, expect, it, vi } from 'vitest'
import type { ProviderChatRequest } from '../../shared/providerRuntime'
import { executeOpenAICompatibleWithReasoningFallback, openAIRequest } from './providerRuntime'

function openRouterRequest(thinkingEnabled = false): ProviderChatRequest {
  return {
    target: { providerKind: 'openrouter', model: 'openai/gpt-oss-20b:free' },
    messages: [{ role: 'user', content: 'Hello' }],
    thinkingEnabled,
    purpose: 'conversation'
  }
}

describe('OpenRouter request compatibility', () => {
  it('represents an explicit disabled-thinking preference', () => {
    expect(openAIRequest(openRouterRequest())).toMatchObject({
      reasoning: { effort: 'none' }
    })
  })

  it('retries once without the override when a model requires reasoning', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Reasoning is mandatory for this endpoint and cannot be disabled.'
      })
      .mockResolvedValueOnce({ ok: true })

    await expect(
      executeOpenAICompatibleWithReasoningFallback(openRouterRequest(), execute)
    ).resolves.toEqual({ ok: true })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0][0]).toMatchObject({ reasoning: { effort: 'none' } })
    expect(execute.mock.calls[1][0]).not.toHaveProperty('reasoning')
  })

  it('does not retry unrelated provider failures', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, error: 'Invalid API key' })
    await executeOpenAICompatibleWithReasoningFallback(openRouterRequest(), execute)
    expect(execute).toHaveBeenCalledOnce()
  })
})
