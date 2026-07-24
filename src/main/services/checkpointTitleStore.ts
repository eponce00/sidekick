import type Database from 'better-sqlite3'
import {
  CHECKPOINT_TITLE_BACKFILL_RETRY_MS,
  CHECKPOINT_TITLE_VERSION,
  checkpointTitleVersionForSource,
  type CheckpointHistoryItem,
  type CheckpointTitleContext,
  type CheckpointTitleIdentity,
  type CheckpointTitleSource,
  type CompleteCheckpointTitleBackfillInput,
  type FailCheckpointTitleBackfillInput
} from '../../shared/checkpointTitles'

const ELIGIBLE_SOURCES = "'legacy', 'fallback', 'generated'"

interface RawCheckpoint {
  hash: string
  message: string
  timestamp: number
  workspaceRoot: string
}

interface CheckpointTitleRow {
  checkpoint_hash: string
  label: string
  label_source: CheckpointTitleSource
  label_version: number
}

interface CheckpointTitleStoreOptions {
  now?: () => number
}

export class CheckpointTitleStore {
  private readonly now: () => number

  constructor(
    private readonly db: Database.Database,
    options: CheckpointTitleStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  sync(workspaceRoot: string, checkpoints: RawCheckpoint[]): CheckpointHistoryItem[] {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO checkpoint_labels
       (workspace_root, checkpoint_hash, label, label_source, label_version, created_at, updated_at)
       VALUES (?, ?, ?, 'legacy', 0, ?, ?)`
    )
    const remove = this.db.prepare(
      'DELETE FROM checkpoint_labels WHERE workspace_root = ? AND checkpoint_hash = ?'
    )
    const transaction = this.db.transaction(() => {
      const now = this.now()
      for (const checkpoint of checkpoints) {
        insert.run(workspaceRoot, checkpoint.hash, checkpoint.message, now, now)
      }

      const activeHashes = new Set(checkpoints.map(({ hash }) => hash))
      const storedHashes = this.db
        .prepare('SELECT checkpoint_hash FROM checkpoint_labels WHERE workspace_root = ?')
        .all(workspaceRoot) as Array<{ checkpoint_hash: string }>
      for (const { checkpoint_hash: hash } of storedHashes) {
        if (!activeHashes.has(hash)) remove.run(workspaceRoot, hash)
      }
    })
    transaction()

    const rows = this.db
      .prepare(
        `SELECT checkpoint_hash, label, label_source, label_version
         FROM checkpoint_labels WHERE workspace_root = ?`
      )
      .all(workspaceRoot) as CheckpointTitleRow[]
    const labels = new Map(rows.map((row) => [row.checkpoint_hash, row]))
    return checkpoints.map((checkpoint) => {
      const row = labels.get(checkpoint.hash)
      return {
        ...checkpoint,
        message: row?.label ?? checkpoint.message,
        titleSource: row?.label_source ?? 'legacy',
        titleVersion: row?.label_version ?? 0
      }
    })
  }

  recordCreated(workspaceRoot: string, hash: string, label: string): void {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO checkpoint_labels
         (workspace_root, checkpoint_hash, label, label_source, label_version, created_at, updated_at)
         VALUES (?, ?, ?, 'fallback', 0, ?, ?)
         ON CONFLICT(workspace_root, checkpoint_hash) DO UPDATE SET
           label = excluded.label,
           label_source = 'fallback',
           label_version = 0,
           backfill_attempted_at = NULL,
           backfill_error = NULL,
           updated_at = excluded.updated_at`
      )
      .run(workspaceRoot, hash, label, now, now)
  }

  updateLabel(
    workspaceRoot: string,
    hash: string,
    label: string,
    source: CheckpointTitleSource
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE checkpoint_labels
         SET label = ?, label_source = ?, label_version = ?,
             backfill_error = NULL, updated_at = ?
         WHERE workspace_root = ? AND checkpoint_hash = ?`
      )
      .run(label, source, checkpointTitleVersionForSource(source), this.now(), workspaceRoot, hash)
    return result.changes === 1
  }

  claim(input: CheckpointTitleIdentity): boolean {
    const now = this.now()
    const result = this.db
      .prepare(
        `UPDATE checkpoint_labels
         SET backfill_attempted_at = ?, backfill_error = NULL
         WHERE workspace_root = ?
           AND checkpoint_hash = ?
           AND label = ?
           AND label_source IN (${ELIGIBLE_SOURCES})
           AND label_version < ?
           AND (
             backfill_attempted_at IS NULL OR
             backfill_attempted_at <= ?
           )`
      )
      .run(
        now,
        input.workspaceRoot,
        input.hash,
        input.expectedTitle,
        CHECKPOINT_TITLE_VERSION,
        now - CHECKPOINT_TITLE_BACKFILL_RETRY_MS
      )
    return result.changes === 1
  }

  complete(input: CompleteCheckpointTitleBackfillInput): boolean {
    const result = this.db
      .prepare(
        `UPDATE checkpoint_labels
         SET label = ?, label_source = 'generated', label_version = ?,
             backfill_error = NULL, updated_at = ?
         WHERE workspace_root = ?
           AND checkpoint_hash = ?
           AND label = ?
           AND label_source IN (${ELIGIBLE_SOURCES})
           AND label_version < ?`
      )
      .run(
        input.title,
        CHECKPOINT_TITLE_VERSION,
        this.now(),
        input.workspaceRoot,
        input.hash,
        input.expectedTitle,
        CHECKPOINT_TITLE_VERSION
      )
    return result.changes === 1
  }

  fail(input: FailCheckpointTitleBackfillInput): boolean {
    const result = this.db
      .prepare(
        `UPDATE checkpoint_labels
         SET backfill_error = ?
         WHERE workspace_root = ?
           AND checkpoint_hash = ?
           AND label = ?
           AND label_source IN (${ELIGIBLE_SOURCES})
           AND label_version < ?`
      )
      .run(
        input.error.slice(0, 500),
        input.workspaceRoot,
        input.hash,
        input.expectedTitle,
        CHECKPOINT_TITLE_VERSION
      )
    return result.changes === 1
  }

  findContext(
    workspaceRoot: string,
    hash: string,
    checkpointTimestamp: number
  ): CheckpointTitleContext | null {
    const assistant = this.db
      .prepare(
        `SELECT m.conversation_id AS conversationId, m.content, m.timestamp
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN projects p ON p.id = c.project_id
         WHERE p.folder_path = ?
           AND m.role IN ('agent', 'assistant')
           AND (
             m.checkpoint_hash = ? OR
             m.timestamp BETWEEN ? AND ?
           )
         ORDER BY
           CASE WHEN m.checkpoint_hash = ? THEN 0 ELSE 1 END,
           abs(m.timestamp - ?) ASC
         LIMIT 1`
      )
      .get(
        workspaceRoot,
        hash,
        checkpointTimestamp - 2 * 60_000,
        checkpointTimestamp + 2 * 60_000,
        hash,
        checkpointTimestamp
      ) as { conversationId: string; content: string; timestamp: number } | undefined
    if (!assistant) return null

    const user = this.db
      .prepare(
        `SELECT content
         FROM messages
         WHERE conversation_id = ? AND role = 'user' AND timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get(assistant.conversationId, assistant.timestamp) as { content: string } | undefined
    return {
      userContent: user?.content ?? '',
      assistantContent: assistant.content
    }
  }
}
