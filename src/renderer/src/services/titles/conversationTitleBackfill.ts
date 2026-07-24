import type { ConversationTitleBackfillCandidate } from '../../../../shared/conversationTitles'
import {
  createFallbackConversationTitle,
  isPlaceholderConversationTitle
} from '../../utils/chatPanelHelpers'

export type ConversationTitleBackfillDecision = 'generate' | 'preserve'

export function decideConversationTitleBackfill(
  candidate: ConversationTitleBackfillCandidate
): ConversationTitleBackfillDecision {
  if (
    candidate.titleSource === 'placeholder' ||
    candidate.titleSource === 'fallback' ||
    candidate.titleSource === 'generated'
  ) {
    return 'generate'
  }

  if (candidate.titleSource === 'legacy') {
    if (isPlaceholderConversationTitle(candidate.title)) return 'generate'
    const expectedFallback = createFallbackConversationTitle(candidate.firstUserMessage)
    if (candidate.title.trim() === expectedFallback) return 'generate'
  }

  return 'preserve'
}
