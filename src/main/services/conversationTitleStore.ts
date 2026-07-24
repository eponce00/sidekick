import type Database from 'better-sqlite3'
import {
  CONVERSATION_TITLE_BACKFILL_RETRY_MS,
  CONVERSATION_TITLE_VERSION,
  type CompleteConversationTitleBackfillInput,
  type ConversationTitleBackfillCandidate,
  type ConversationTitleBackfillIdentity,
  type FailConversationTitleBackfillInput
} from '../../shared/conversationTitles'

const ELIGIBLE_SOURCES = "'legacy', 'placeholder', 'fallback', 'generated'"

interface ConversationTitleStoreOptions {
  now?: () => number
}

export class ConversationTitleStore {
  private readonly now: () => number

  constructor(
    private readonly db: Database.Database,
    options: ConversationTitleStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  listCandidates(limit = 8): ConversationTitleBackfillCandidate[] {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)))
    const retryBefore = this.now() - CONVERSATION_TITLE_BACKFILL_RETRY_MS
    return this.db
      .prepare(
        `SELECT
           c.id,
           c.title,
           c.title_source AS titleSource,
           c.title_version AS titleVersion,
           (
             SELECT substr(m.content, 1, 1000)
             FROM messages m
             WHERE m.conversation_id = c.id
               AND m.role = 'user'
               AND trim(m.content) <> ''
             ORDER BY m.timestamp ASC, m.id ASC
             LIMIT 1
           ) AS firstUserMessage,
           (
             SELECT substr(m.content, 1, 1000)
             FROM messages m
             WHERE m.conversation_id = c.id
               AND m.role IN ('agent', 'assistant')
               AND trim(m.content) <> ''
             ORDER BY m.timestamp ASC, m.id ASC
             LIMIT 1
           ) AS firstAssistantMessage
         FROM conversations c
         WHERE c.title_source IN (${ELIGIBLE_SOURCES})
           AND c.title_version < ?
           AND (
             c.title_backfill_attempted_at IS NULL OR
             c.title_backfill_attempted_at <= ?
           )
           AND EXISTS (
             SELECT 1
             FROM messages m
             WHERE m.conversation_id = c.id
               AND m.role = 'user'
               AND trim(m.content) <> ''
           )
         ORDER BY
           CASE WHEN c.title_backfill_attempted_at IS NULL THEN 0 ELSE 1 END,
           c.updated_at DESC
         LIMIT ?`
      )
      .all(
        CONVERSATION_TITLE_VERSION,
        retryBefore,
        safeLimit
      ) as ConversationTitleBackfillCandidate[]
  }

  claim(input: ConversationTitleBackfillIdentity): boolean {
    const now = this.now()
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title_backfill_attempted_at = ?, title_backfill_error = NULL
         WHERE id = ?
           AND title = ?
           AND title_source IN (${ELIGIBLE_SOURCES})
           AND title_version < ?
           AND (
             title_backfill_attempted_at IS NULL OR
             title_backfill_attempted_at <= ?
           )`
      )
      .run(
        now,
        input.id,
        input.expectedTitle,
        CONVERSATION_TITLE_VERSION,
        now - CONVERSATION_TITLE_BACKFILL_RETRY_MS
      )
    return result.changes === 1
  }

  complete(input: CompleteConversationTitleBackfillInput): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title = ?,
             title_source = 'generated',
             title_version = ?,
             title_backfill_error = NULL
         WHERE id = ?
           AND title = ?
           AND title_source IN (${ELIGIBLE_SOURCES})
           AND title_version < ?`
      )
      .run(
        input.title,
        CONVERSATION_TITLE_VERSION,
        input.id,
        input.expectedTitle,
        CONVERSATION_TITLE_VERSION
      )
    return result.changes === 1
  }

  fail(input: FailConversationTitleBackfillInput): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title_backfill_error = ?
         WHERE id = ?
           AND title = ?
           AND title_source IN (${ELIGIBLE_SOURCES})
           AND title_version < ?`
      )
      .run(input.error.slice(0, 500), input.id, input.expectedTitle, CONVERSATION_TITLE_VERSION)
    return result.changes === 1
  }

  preserve(input: ConversationTitleBackfillIdentity): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title_source = 'preserved',
             title_version = ?,
             title_backfill_error = NULL
         WHERE id = ?
           AND title = ?
           AND title_source IN (${ELIGIBLE_SOURCES})
           AND title_version < ?`
      )
      .run(CONVERSATION_TITLE_VERSION, input.id, input.expectedTitle, CONVERSATION_TITLE_VERSION)
    return result.changes === 1
  }
}
