// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFallbackConversationTitle,
  estimateProviderRequestTokens,
  generateConversationTitle,
  isPlaceholderConversationTitle,
  normalizeGeneratedConversationTitle
} from './chatPanelHelpers'

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
    ).toBe('one two three four five six seven eight')
  })

  it('builds a concise local fallback from the first user message', () => {
    expect(
      createFallbackConversationTitle(
        '¿Cómo puedo mejorar el sistema de títulos automáticos en SideKick hoy?'
      )
    ).toBe('¿Cómo puedo mejorar el sistema de títulos')
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
})
