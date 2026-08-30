// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFallbackConversationTitle,
  estimateProviderRequestTokens,
  generateConversationTitle,
  getQueuedMessageIdForEmptySubmit,
  isPlaceholderConversationTitle,
  normalizeGeneratedConversationTitle
} from './chatPanelHelpers'

describe('queued message keyboard submission', () => {
  const queuedMessages = [{ id: 'oldest' }, { id: 'newest' }]

  it('selects the oldest queued message when an empty composer is submitted during a run', () => {
    expect(getQueuedMessageIdForEmptySubmit(true, false, queuedMessages)).toBe('oldest')
  })

  it('does not promote a queued message when the composer has new content', () => {
    expect(getQueuedMessageIdForEmptySubmit(true, true, queuedMessages)).toBeNull()
  })

  it('does not promote a queued message outside an active run or with an empty queue', () => {
    expect(getQueuedMessageIdForEmptySubmit(false, false, queuedMessages)).toBeNull()
    expect(getQueuedMessageIdForEmptySubmit(true, false, [])).toBeNull()
  })
})

describe('conversation titles', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ollama: { fetch: vi.fn(async () => ({ ok: false, error: 'offline' })) },
        lmstudio: { chatComplete: vi.fn(async () => ({ ok: false, error: 'offline' })) }
      }
    })
  })

  it('recognizes only empty and default placeholder titles', () => {
    expect(isPlaceholderConversationTitle('New Conversation')).toBe(true)
    expect(isPlaceholderConversationTitle('  ')).toBe(true)
    expect(isPlaceholderConversationTitle('Nueva conversación')).toBe(false)
  })

  it('normalizes model formatting and bounds verbose title output', () => {
    expect(normalizeGeneratedConversationTitle('Título: “Población de Cuba”.')).toBe(
      'Población de Cuba'
    )
    expect(
      normalizeGeneratedConversationTitle('one two three four five six seven eight nine ten')
    ).toBe('one two three four five six')
  })

  it('removes useful meta narration and rejects naming-instruction remnants', () => {
    expect(
      normalizeGeneratedConversationTitle('The user is asking me to fix the Windows installer')
    ).toBe('fix the Windows installer')
    expect(normalizeGeneratedConversationTitle('The user is asking me to create a')).toBeNull()
    expect(normalizeGeneratedConversationTitle('The user wants me to create a 2-5')).toBeNull()
    expect(
      normalizeGeneratedConversationTitle('<think>The user wants a title but never closed it')
    ).toBeNull()
    expect(normalizeGeneratedConversationTitle('I need to improve automatic chat titles')).toBe(
      'improve automatic chat titles'
    )
  })

  it('builds a concise local fallback from the first user message', () => {
    expect(
      createFallbackConversationTitle(
        '¿Cómo puedo mejorar el sistema de títulos automáticos en SideKick hoy?'
      )
    ).toBe('¿Cómo puedo mejorar el sistema de títulos')
  })

  it('strips meta narration from the deterministic fallback too', () => {
    expect(
      createFallbackConversationTitle('The user wants me to fix the Windows installer flow')
    ).toBe('Fix the Windows installer flow')
  })

  it('does not leave deterministic fallback titles on dangling connector words', () => {
    expect(
      createFallbackConversationTitle(
        'find a good quality tts engine we can use for local narration'
      )
    ).toBe('Find a good quality tts engine')
  })

  it('includes tool schemas and provider framing in request token estimates', () => {
    const withoutTools = estimateProviderRequestTokens([{ role: 'user', content: 'hello' }], [])
    const withTools = estimateProviderRequestTokens(
      [{ role: 'user', content: 'hello' }],
      [{ type: 'function', function: { name: 'search', description: 'x'.repeat(400) } }]
    )
    expect(withTools).toBeGreaterThan(withoutTools + 90)
  })

  it('updates the conversation with a fallback when the title provider fails', async () => {
    const onUpdateTitle = vi.fn(async () => undefined)
    const result = await generateConversationTitle(
      {
        provider: 'openrouter',
        model: 'test-model',
        contextLength: 128_000,
        fallbackTitle: 'Investiga el límite moderno de herramientas',
        onUpdateTitle
      },
      'conversation-1',
      [{ role: 'user', content: 'Create a concise title' }]
    )

    expect(result).toBe('Investiga el límite moderno de herramientas')
    expect(onUpdateTitle).toHaveBeenCalledWith(
      'conversation-1',
      'Investiga el límite moderno de herramientas'
    )
  })

  it('never promotes hidden reasoning to a conversation title', async () => {
    const onUpdateTitle = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        providers: {
          complete: vi.fn(async () => ({
            ok: true,
            data: {
              message: {
                role: 'assistant',
                content: '',
                thinking: 'The user wants me to create a 2-5 word conversation title'
              },
              promptTokens: 10,
              completionTokens: 8,
              reasoningTokens: 8,
              finishReason: 'stop'
            }
          }))
        }
      }
    })

    const result = await generateConversationTitle(
      {
        provider: 'openrouter',
        model: 'test-model',
        contextLength: 128_000,
        fallbackTitle: 'Fix the Windows installer flow',
        onUpdateTitle
      },
      'conversation-1',
      [{ role: 'user', content: 'Create a concise title' }]
    )

    expect(result).toBe('Fix the Windows installer flow')
    expect(onUpdateTitle).not.toHaveBeenCalledWith(
      'conversation-1',
      expect.stringContaining('The user')
    )
  })
})
