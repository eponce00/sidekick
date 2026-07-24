import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  ConversationCompactionRecord,
  SaveConversationCompactionInput
} from '../../shared/conversationCompactions'

interface ConversationCompactionRow {
  id: string
  conversation_id: string
  summary: string
  compacted_through_message_id: string | null
  compacted_through_timestamp: number | null
  previous_compaction_id: string | null
  original_tokens: number
  summary_tokens: number
  messages_compacted: number
  strategy: ConversationCompactionRecord['strategy']
  prompt_version: string
  provider: string
  model: string
  created_at: number
}

function mapCompaction(row: ConversationCompactionRow): ConversationCompactionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    summary: row.summary,
    compactedThroughMessageId: row.compacted_through_message_id,
    compactedThroughTimestamp: row.compacted_through_timestamp,
    previousCompactionId: row.previous_compaction_id,
    originalTokens: row.original_tokens,
    summaryTokens: row.summary_tokens,
    messagesCompacted: row.messages_compacted,
    strategy: row.strategy,
    promptVersion: row.prompt_version,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at
  }
}

export class ConversationCompactionStore {
  constructor(private readonly db: Database.Database) {}

  latest(conversationId: string): ConversationCompactionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_compactions
         WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(conversationId) as ConversationCompactionRow | undefined
    return row ? mapCompaction(row) : null
  }

  save(input: SaveConversationCompactionInput): ConversationCompactionRecord {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO conversation_compactions
         (id, conversation_id, summary, compacted_through_message_id,
          compacted_through_timestamp, previous_compaction_id, original_tokens,
          summary_tokens, messages_compacted, strategy, prompt_version, provider, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.summary,
        input.compactedThroughMessageId ?? null,
        input.compactedThroughTimestamp ?? null,
        input.previousCompactionId ?? null,
        input.originalTokens,
        input.summaryTokens,
        input.messagesCompacted,
        input.strategy,
        input.promptVersion,
        input.provider,
        input.model,
        createdAt
      )
    return this.get(id)!
  }

  get(id: string): ConversationCompactionRecord | null {
    const row = this.db.prepare('SELECT * FROM conversation_compactions WHERE id = ?').get(id) as
      | ConversationCompactionRow
      | undefined
    return row ? mapCompaction(row) : null
  }

  invalidateFromTimestamp(conversationId: string, timestamp: number): number {
    return this.db
      .prepare(
        `DELETE FROM conversation_compactions
         WHERE conversation_id = ?
           AND compacted_through_timestamp IS NOT NULL
           AND compacted_through_timestamp >= ?`
      )
      .run(conversationId, timestamp).changes
  }

  invalidateAfterTimestamp(conversationId: string, timestamp: number): number {
    return this.db
      .prepare(
        `DELETE FROM conversation_compactions
         WHERE conversation_id = ?
           AND compacted_through_timestamp IS NOT NULL
           AND compacted_through_timestamp > ?`
      )
      .run(conversationId, timestamp).changes
  }

  copyLatestForFork(
    sourceConversationId: string,
    targetConversationId: string,
    messageIdMap: ReadonlyMap<string, string>,
    throughTimestamp?: number
  ): ConversationCompactionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_compactions
         WHERE conversation_id = ?
           AND (? IS NULL OR compacted_through_timestamp IS NULL OR compacted_through_timestamp <= ?)
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(sourceConversationId, throughTimestamp ?? null, throughTimestamp ?? null) as
      | ConversationCompactionRow
      | undefined
    if (!row) return null

    return this.save({
      conversationId: targetConversationId,
      summary: row.summary,
      compactedThroughMessageId: row.compacted_through_message_id
        ? (messageIdMap.get(row.compacted_through_message_id) ?? null)
        : null,
      compactedThroughTimestamp: row.compacted_through_timestamp,
      originalTokens: row.original_tokens,
      summaryTokens: row.summary_tokens,
      messagesCompacted: row.messages_compacted,
      strategy: row.strategy,
      promptVersion: row.prompt_version,
      provider: row.provider,
      model: row.model
    })
  }
}
