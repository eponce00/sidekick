import { describe, expect, it } from 'vitest'
import type { ConversationTitleBackfillCandidate } from '../../../../shared/conversationTitles'
import { decideConversationTitleBackfill } from './conversationTitleBackfill'

function candidate(
  title: string,
  titleSource: ConversationTitleBackfillCandidate['titleSource']
): ConversationTitleBackfillCandidate {
  return {
    id: 'conversation-1',
    title,
    titleSource,
    titleVersion: 0,
    firstUserMessage: 'explain how distributed queues preserve message ordering',
    firstAssistantMessage: null
  }
}

describe('decideConversationTitleBackfill', () => {
  it('regenerates placeholders, fallbacks, and malformed generated titles', () => {
    expect(decideConversationTitleBackfill(candidate('New Conversation', 'placeholder'))).toBe(
      'generate'
    )
    expect(decideConversationTitleBackfill(candidate('Anything', 'fallback'))).toBe('generate')
    expect(
      decideConversationTitleBackfill(candidate('The user wants me to create a 2-5', 'generated'))
    ).toBe('generate')
    // A legacy title equal to the deterministic fallback was never chosen by anyone.
    expect(
      decideConversationTitleBackfill(
        candidate('Explain how distributed queues preserve message ordering', 'legacy')
      )
    ).toBe('generate')
  })

  it('preserves useful generated titles and legacy titles that may be manual names', () => {
    expect(
      decideConversationTitleBackfill(candidate('Replace image and add lightbox', 'generated'))
    ).toBe('preserve')
    expect(decideConversationTitleBackfill(candidate('Queue research notes', 'legacy'))).toBe(
      'preserve'
    )
  })
})
