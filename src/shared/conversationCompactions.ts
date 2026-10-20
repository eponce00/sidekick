/**
 * Why a compaction used the deterministic summary instead of the model's. Recorded on
 * `compaction.completed` and counted by the run audit and the diagnostics export; never content.
 */
export const COMPACTION_FALLBACK_REASONS = [
  /** The model made no progress for too long, or something in front of it gave up waiting. */
  'timeout',
  /** The connection closed while the summary was being written. */
  'connection_lost',
  'server_unreachable',
  /** The summary request did not fit the model's window. */
  'context_overflow',
  /** Any other refusal or failure, with its HTTP status when there was one. */
  'provider_error',
  /** The summary used its whole output allowance and was cut off. */
  'output_limit',
  /** The model only reasoned, and wrote no summary. */
  'reasoning_only',
  'empty_output'
] as const

export type CompactionFallbackReason = (typeof COMPACTION_FALLBACK_REASONS)[number]

export interface ConversationCompactionRecord {
  id: string
  conversationId: string
  summary: string
  compactedThroughMessageId: string | null
  compactedThroughTimestamp: number | null
  previousCompactionId: string | null
  originalTokens: number
  summaryTokens: number
  messagesCompacted: number
  strategy: 'model' | 'deterministic'
  promptVersion: string
  provider: string
  model: string
  /**
   * The reply after the anchor that the summary also reaches into, when it summarized a run's own
   * work, and how many of that reply's provider messages it replaced.
   */
  replyMessageId: string | null
  replyMessagesCovered: number
  createdAt: number
}

export interface SaveConversationCompactionInput {
  conversationId: string
  summary: string
  compactedThroughMessageId?: string | null
  compactedThroughTimestamp?: number | null
  previousCompactionId?: string | null
  originalTokens: number
  summaryTokens: number
  messagesCompacted: number
  strategy: 'model' | 'deterministic'
  promptVersion: string
  provider: string
  model: string
  replyMessageId?: string | null
  replyMessagesCovered?: number
}
