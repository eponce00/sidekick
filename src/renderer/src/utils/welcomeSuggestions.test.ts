import { describe, expect, it } from 'vitest'
import { createWelcomeSuggestions } from './welcomeSuggestions'

describe('createWelcomeSuggestions', () => {
  it('prioritizes project context and deduplicates conversation titles', () => {
    const suggestions = createWelcomeSuggestions({
      projectName: 'SideKick',
      recentConversationTitles: [
        'Provider settings redesign',
        'Provider settings redesign',
        'New Conversation'
      ]
    })

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      'Explore SideKick',
      'Revisit “Provider settings redesign”'
    ])
  })
})
