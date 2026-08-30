import { describe, expect, it, vi } from 'vitest'
import {
  completeOpenAICompatibleChat,
  fetchOpenAICompatibleModels,
  normalizeOpenAICompatibleEndpoint,
  openAICompatibleHeaders
} from './openAICompatibleClient'
import { readIncompleteToolInputError } from '../../shared/toolCalls'

describe('OpenAI-compatible client', () => {
  it('normalizes endpoints and adds optional bearer authentication', () => {
    expect(normalizeOpenAICompatibleEndpoint(' https://provider.test/v1/// ')).toBe(
      'https://provider.test/v1'
    )
    expect(openAICompatibleHeaders()).toEqual({ 'Content-Type': 'application/json' })
    expect(openAICompatibleHeaders(' secret ')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret'
    })
  })

  it('validates model catalogs returned by the provider', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] })))
    const result = await fetchOpenAICompatibleModels(
      'https://provider.test/v1/',
      openAICompatibleHeaders(),
      fetchImpl as typeof fetch
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://provider.test/v1/models',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
    )
    expect(result).toMatchObject({ ok: true, data: { data: [{ id: 'model-a' }] } })
  })

  it('normalizes completion content, thinking, tool calls, and usage', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: '<think>check first</think>Ready',
                  tool_calls: [
                    { id: 'call-1', function: { name: 'read_file', arguments: { path: 'a.txt' } } }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 }
            }
          })
        )
    )
    const result = await completeOpenAICompatibleChat(
      'https://provider.test/v1',
      { model: 'model-a', messages: [] },
      openAICompatibleHeaders(),
      fetchImpl as typeof fetch
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        message: {
          content: 'Ready',
          thinking: 'check first',
          tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
        },
        promptTokens: 4,
        cachedPromptTokens: 3,
        completionTokens: 5,
        reasoningTokens: 2,
        finishReason: 'tool_calls'
      }
    })
  })

  it('normalizes provider-native reasoning_content', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Final',
                  reasoning_content: 'Checked the answer'
                }
              }
            ]
          })
        )
    )
    const result = await completeOpenAICompatibleChat(
      'https://provider.test/v1',
      { model: 'reasoning-model', messages: [] },
      openAICompatibleHeaders(),
      fetchImpl as typeof fetch
    )
    expect(result.data?.message).toMatchObject({
      content: 'Final',
      thinking: 'Checked the answer'
    })
  })

  it('marks malformed non-streaming tool input as incomplete instead of executing it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'write-1',
                      function: {
                        name: 'write',
                        arguments: '{"file_path":"src/app.ts","content":"export'
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
    )

    const result = await completeOpenAICompatibleChat(
      'https://provider.test/v1',
      { model: 'model-a', messages: [] },
      openAICompatibleHeaders(),
      fetchImpl as typeof fetch
    )

    expect(
      readIncompleteToolInputError(result.data?.message.tool_calls?.[0].function.arguments)
    ).toContain('tool was not executed')
  })

  it('returns provider error details and status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'Bad model' } }), { status: 400 })
    )
    await expect(
      completeOpenAICompatibleChat(
        'https://provider.test/v1',
        {},
        openAICompatibleHeaders(),
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ ok: false, error: 'Bad model', status: 400 })
  })

  it('includes the network error code without leaking request details', async () => {
    const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause })
    })
    await expect(
      fetchOpenAICompatibleModels(
        'https://provider.test/v1',
        openAICompatibleHeaders('secret'),
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ ok: false, error: 'fetch failed (ECONNRESET)' })
  })
})
