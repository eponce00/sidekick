import { describe, expect, it, vi } from 'vitest'
import { refinePrompt } from './promptRefinement'
import type { UtilityCompletionRequest } from './utilityCompletion'

const config = {
  model: {
    provider: 'litellm' as const,
    providerKind: 'litellm' as const,
    providerInstanceId: 'home-server',
    model: 'local-loaded-model',
    contextLength: 180_000
  },
  context: { surface: 'project' as const, projectName: 'SideKick' }
}

function successfulCompletion(text: string) {
  return {
    ok: true,
    text,
    message: { role: 'assistant', content: text },
    promptTokens: 10,
    completionTokens: 20,
    reasoningTokens: 0,
    finishReason: 'stop',
    attempts: 1
  }
}

describe('promptRefinement', () => {
  it('uses the selected provider with a dedicated, bounded utility request', async () => {
    const complete = vi.fn(async () =>
      successfulCompletion(
        '```markdown\nRefined prompt: Build the dashboard and validate the result.\n```'
      )
    )

    const result = await refinePrompt('build the dashboard', config, complete)

    expect(result).toEqual({
      ok: true,
      text: 'Build the dashboard and validate the result.'
    })
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: config.model,
        purpose: 'prompt-refinement',
        think: false,
        temperature: 0.3,
        maxOutputTokens: 1024
      })
    )
  })

  it('passes recent conversation context to the utility model', async () => {
    const complete = vi.fn(async (_request: UtilityCompletionRequest) =>
      successfulCompletion('Fix the existing map rendering.')
    )

    await refinePrompt(
      'fix it',
      {
        ...config,
        context: {
          ...config.context,
          recentHistory: [
            {
              role: 'user',
              speaker: 'You',
              content: 'The map is blank but province points respond to hover.'
            }
          ]
        }
      },
      complete
    )

    const request = complete.mock.calls[0][0]
    expect(request.messages[1].content).toContain('type="recent_conversation"')
    expect(request.messages[1].content).toContain('province points respond to hover')
    expect(request.messages[1].content).toContain('type="prompt_draft"')
  })

  it('does not present an empty or unchanged response as an improvement', async () => {
    const unchanged = await refinePrompt(
      'Already clear prompt',
      config,
      vi.fn(async () => successfulCompletion('  Already   clear prompt '))
    )
    const empty = await refinePrompt(
      'Improve this request',
      config,
      vi.fn(async () => successfulCompletion('<think>Only reasoning</think>'))
    )

    expect(unchanged).toEqual({ ok: false, error: 'This prompt is already clear.' })
    expect(empty).toEqual({ ok: false, error: 'The model returned an empty prompt.' })
  })

  it('returns provider failures without changing the draft', async () => {
    const result = await refinePrompt(
      'Improve this request',
      config,
      vi.fn(async () => ({
        ok: false,
        text: '',
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        attempts: 1,
        error: { code: 'timeout' as const, message: 'Provider timed out', retryable: true }
      }))
    )

    expect(result).toEqual({ ok: false, error: 'Provider timed out' })
  })
})
