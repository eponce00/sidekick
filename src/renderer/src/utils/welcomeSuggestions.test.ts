import { describe, expect, it } from 'vitest'
import { createWelcomeSuggestions } from './welcomeSuggestions'

describe('createWelcomeSuggestions', () => {
  it('returns exactly two suggestions based on recent work', () => {
    const suggestions = createWelcomeSuggestions({
      recentConversationTitles: [
        'Refine the desktop experience',
        'Research local model options',
        'Build release checklist'
      ]
    })

    expect(suggestions).toHaveLength(2)
    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      'Continue “Refine the desktop experience”',
      'Revisit “Research local model options”'
    ])
  })

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

  it('uses two concise fallbacks for a new profile', () => {
    const suggestions = createWelcomeSuggestions({
      recentConversationTitles: [' ', 'Untitled conversation']
    })

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
      'Plan something new',
      'Explore an idea'
    ])
  })
})
