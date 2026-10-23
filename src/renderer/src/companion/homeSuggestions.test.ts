import { describe, expect, it } from 'vitest'
import type { CompanionChat } from '../../../shared/companion'
import { homeSuggestions } from './homeSuggestions'

function chat(id: string, title: string, updatedAt: number, pinned = false): CompanionChat {
  return {
    id,
    title,
    updatedAt,
    pinned,
    projectName: null,
    activePhase: null,
    needsAnswer: false
  }
}

describe('homeSuggestions', () => {
  it('offers the chat worked on last, even when a pinned one is listed first, and a starter', () => {
    const suggestions = homeSuggestions([
      chat('pinned', 'Pinned chat', 10, true),
      chat('recent', 'Fix the flaky upload test', 50),
      chat('older', 'Plan the trip', 20)
    ])
    expect(suggestions).toHaveLength(2)
    expect(suggestions[0]).toMatchObject({
      kind: 'open',
      label: 'Continue “Fix the flaky upload test”'
    })
    expect(suggestions[0].kind === 'open' && suggestions[0].chat.id).toBe('recent')
    expect(suggestions[1]).toMatchObject({ kind: 'prompt', label: 'Plan something new' })
  })

  it('skips chats with placeholder titles and shortens long ones', () => {
    const [first] = homeSuggestions([
      chat('new', 'New chat', 90),
      chat('long', 'Compare trail running shoes under one hundred and fifty', 10)
    ])
    expect(first.label).toBe('Continue “Compare trail running shoes u…”')
  })

  it('offers the two starters when there are no chats yet', () => {
    expect(homeSuggestions([]).map((suggestion) => suggestion.kind)).toEqual(['prompt', 'prompt'])
    expect(homeSuggestions(null)).toHaveLength(2)
  })
})
