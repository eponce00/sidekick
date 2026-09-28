/** Why a conversation needs the user: an approval, an answer, or a run that failed. */
export type ConversationAttentionReason = 'approval' | 'question' | 'failed'

export interface ConversationAttentionAlert {
  conversationId: string
  reason: ConversationAttentionReason
}

export interface ConversationAttentionState {
  /** Conversations whose agent is paused on a pending approval or question. */
  waitingConversationIds: string[]
  /** Set when this change is a conversation starting to wait, or a run failing. */
  alert?: ConversationAttentionAlert
}
