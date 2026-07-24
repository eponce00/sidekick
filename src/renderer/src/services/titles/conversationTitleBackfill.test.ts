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
  it('regenerates titles explicitly owned by SideKick title paths', () => {
    expect(decideConversationTitleBackfill(candidate('New Conversation', 'placeholder'))).toBe(
      'generate'
    )
    expect(decideConversationTitleBackfill(candidate('Anything', 'fallback'))).toBe('generate')
    expect(decideConversationTitleBackfill(candidate('Older generated title', 'generated'))).toBe(
      'generate'
    )
  })

  it('regenerates legacy titles that exactly match the deterministic fallback', () => {
    expect(
      decideConversationTitleBackfill(
        candidate('Explain how distributed queues preserve message ordering', 'legacy')
      )
    ).toBe('generate')
  })

  it('preserves ambiguous legacy titles instead of overwriting possible manual names', () => {
    expect(decideConversationTitleBackfill(candidate('Queue research notes', 'legacy'))).toBe(
      'preserve'
    )
  })
})
