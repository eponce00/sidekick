import type { ConversationTitleBackfillCandidate } from '../../../../shared/conversationTitles'
import { isUsableGeneratedConversationTitle } from '../../../../shared/conversationTitles'
import {
  createFallbackConversationTitle,
  isPlaceholderConversationTitle
} from '../../utils/chatPanelHelpers'

export type ConversationTitleBackfillDecision = 'generate' | 'preserve'

export function decideConversationTitleBackfill(
  candidate: ConversationTitleBackfillCandidate
): ConversationTitleBackfillDecision {
  if (candidate.titleSource === 'placeholder' || candidate.titleSource === 'fallback') {
    return 'generate'
  }

  if (candidate.titleSource === 'generated') {
    return isUsableGeneratedConversationTitle(candidate.title) ? 'preserve' : 'generate'
  }

  if (candidate.titleSource === 'legacy') {
    if (isPlaceholderConversationTitle(candidate.title)) return 'generate'
    const expectedFallback = createFallbackConversationTitle(candidate.firstUserMessage)
    if (candidate.title.trim() === expectedFallback) return 'generate'
  }

  return 'preserve'
}
