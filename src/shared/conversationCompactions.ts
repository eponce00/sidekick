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
}
