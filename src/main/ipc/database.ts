import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { getDb } from './state'
import { resolveKnownWorkspace } from './workspaceUtils'
import { ConversationCompactionStore } from '../services/conversationCompactionStore'
import { ConversationTitleStore } from '../services/conversationTitleStore'
import { loadContextUsageByOutputMessage } from '../services/agentRunContextUsage'
import type { SaveConversationCompactionInput } from '../../shared/conversationCompactions'
import {
  conversationTitleVersionForSource,
  isConversationTitleSource,
  type CompleteConversationTitleBackfillInput,
  type ConversationTitleBackfillIdentity,
  type ConversationTitleUpdateOptions,
  type FailConversationTitleBackfillInput
} from '../../shared/conversationTitles'

function validBackfillIdentity(input: unknown): input is ConversationTitleBackfillIdentity {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.id.length <= 100 &&
    typeof candidate.expectedTitle === 'string' &&
    candidate.expectedTitle.length <= 500
  )
}

export function registerDatabaseHandlers(): void {
  const db = getDb()
  const compactions = new ConversationCompactionStore(db)
  const conversationTitles = new ConversationTitleStore(db)

  ipcMain.handle('conversations:list', async () => {
    const stmt = db.prepare(
      'SELECT * FROM conversations ORDER BY sidebar_order ASC, updated_at DESC'
    )
    return stmt.all()
  })

  ipcMain.handle('conversations:search', async (_, query: string) => {
    const normalized = query.trim()
    if (!normalized) {
      return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all()
    }
    const pattern = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`
    return db
      .prepare(
        `SELECT DISTINCT c.*
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
         ORDER BY c.updated_at DESC
         LIMIT 100`
      )
      .all(pattern, pattern)
  })

  ipcMain.handle(
    'conversations:create',
    async (_, title: string, projectId?: string | null, titleSource?: unknown) => {
      const id = randomUUID()
      const now = Date.now()
      const source = isConversationTitleSource(titleSource) ? titleSource : 'placeholder'
      const titleVersion = conversationTitleVersionForSource(source)
      const normalizedProjectId = projectId ?? null
      const project = normalizedProjectId
        ? (db
            .prepare('SELECT name, folder_path FROM projects WHERE id = ?')
            .get(normalizedProjectId) as { name: string; folder_path: string } | undefined)
        : undefined
      if (normalizedProjectId && !project) throw new Error('Project not found')
      const placement = db
        .prepare(
          `SELECT COALESCE(MIN(sidebar_order), 0) - 1 AS sidebar_order
           FROM conversations WHERE project_id IS ?`
        )
        .get(normalizedProjectId) as { sidebar_order: number }
      const stmt = db.prepare(
        `INSERT INTO conversations
         (id, title, created_at, updated_at, project_id, title_source, title_version,
          sidebar_order, project_context_version, home_workspace_root, home_project_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      stmt.run(
        id,
        title,
        now,
        now,
        normalizedProjectId,
        source,
        titleVersion,
        placement.sidebar_order,
        project?.folder_path ?? null,
        project?.name ?? null
      )
      return {
        id,
        title,
        created_at: now,
        updated_at: now,
        project_id: normalizedProjectId,
        title_source: source,
        title_version: titleVersion,
        sidebar_order: placement.sidebar_order,
        project_context_version: 0,
        home_workspace_root: project?.folder_path ?? null,
        home_project_name: project?.name ?? null,
        unread_completion_at: null
      }
    }
  )

  ipcMain.handle('conversations:fork', async (_, sourceId: string, timestamp?: number) => {
    const source = db
      .prepare(
        `SELECT title, project_id, home_workspace_root, home_project_name
         FROM conversations WHERE id = ?`
      )
      .get(sourceId) as
      | {
          title: string
          project_id: string | null
          home_workspace_root: string | null
          home_project_name: string | null
        }
      | undefined
    if (!source) throw new Error('Conversation not found')

    const id = randomUUID()
    const now = Date.now()
    const title = `${source.title} (fork)`
    const placement = db
      .prepare(
        `SELECT COALESCE(MIN(sidebar_order), 0) - 1 AS sidebar_order
         FROM conversations WHERE project_id IS ?`
      )
      .get(source.project_id) as { sidebar_order: number }
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND (? IS NULL OR timestamp <= ?)
         ORDER BY timestamp ASC`
      )
      .all(sourceId, timestamp ?? null, timestamp ?? null) as Record<string, unknown>[]

    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations
         (id, title, created_at, updated_at, project_id, title_source, title_version,
          sidebar_order, project_context_version, home_workspace_root, home_project_name)
         VALUES (?, ?, ?, ?, ?, 'fork', ?, ?, 0, ?, ?)`
      ).run(
        id,
        title,
        now,
        now,
        source.project_id,
        conversationTitleVersionForSource('fork'),
        placement.sidebar_order,
        source.home_workspace_root,
        source.home_project_name
      )
      const insert = db.prepare(
        `INSERT INTO messages
         (id, conversation_id, role, content, thinking, segments, token_usage,
          checkpoint_hash, checkpoint_workspace_root, run_mode, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const messageIdMap = new Map<string, string>()
      for (const row of rows) {
        const copiedMessageId = randomUUID()
        messageIdMap.set(String(row.id), copiedMessageId)
        insert.run(
          copiedMessageId,
          id,
          row.role,
          row.content,
          row.thinking ?? null,
          row.segments ?? null,
          row.token_usage ?? null,
          row.checkpoint_hash ?? null,
          row.checkpoint_workspace_root ?? null,
          row.run_mode === 'research'
            ? 'research'
            : row.run_mode === 'plan'
              ? 'plan'
              : 'conversation',
          row.timestamp
        )
      }
      compactions.copyLatestForFork(sourceId, id, messageIdMap, timestamp)
    })()

    return {
      id,
      title,
      created_at: now,
      updated_at: now,
      project_id: source.project_id,
      title_source: 'fork',
      title_version: conversationTitleVersionForSource('fork'),
      sidebar_order: placement.sidebar_order,
      project_context_version: 0,
      home_workspace_root: source.home_workspace_root,
      home_project_name: source.home_project_name,
      unread_completion_at: null
    }
  })

  ipcMain.handle('conversations:markRead', async (_, id: string) => {
    const result = db
      .prepare('UPDATE conversations SET unread_completion_at = NULL WHERE id = ?')
      .run(id)
    return { success: result.changes === 1 }
  })

  ipcMain.handle(
    'conversations:update',
    async (_, id: string, title: string, options?: ConversationTitleUpdateOptions) => {
      const source = isConversationTitleSource(options?.source) ? options.source : 'user'
      const titleVersion = conversationTitleVersionForSource(source)
      const preserveUpdatedAt = options?.preserveUpdatedAt ?? source !== 'user'
      const now = Date.now()
      const result = preserveUpdatedAt
        ? db
            .prepare(
              `UPDATE conversations
               SET title = ?, title_source = ?, title_version = ?, title_backfill_error = NULL
               WHERE id = ?`
            )
            .run(title, source, titleVersion, id)
        : db
            .prepare(
              `UPDATE conversations
               SET title = ?, title_source = ?, title_version = ?,
                   title_backfill_error = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(title, source, titleVersion, now, id)
      return {
        success: result.changes === 1,
        updatedAt: preserveUpdatedAt ? undefined : now
      }
    }
  )

  ipcMain.handle('conversations:listTitleBackfillCandidates', async (_, limit?: number) => {
    return conversationTitles.listCandidates(typeof limit === 'number' ? limit : undefined)
  })

  ipcMain.handle(
    'conversations:claimTitleBackfill',
    async (_, input: ConversationTitleBackfillIdentity) => {
      if (!validBackfillIdentity(input)) throw new Error('Invalid title backfill identity')
      return { claimed: conversationTitles.claim(input) }
    }
  )

  ipcMain.handle(
    'conversations:completeTitleBackfill',
    async (_, input: CompleteConversationTitleBackfillInput) => {
      if (
        !validBackfillIdentity(input) ||
        typeof input.title !== 'string' ||
        !input.title.trim() ||
        input.title.length > 500
      ) {
        throw new Error('Invalid completed title backfill')
      }
      return { applied: conversationTitles.complete(input) }
    }
  )

  ipcMain.handle(
    'conversations:failTitleBackfill',
    async (_, input: FailConversationTitleBackfillInput) => {
      if (
        !validBackfillIdentity(input) ||
        typeof input.error !== 'string' ||
        input.error.length > 2_000
      ) {
        throw new Error('Invalid failed title backfill')
      }
      return { recorded: conversationTitles.fail(input) }
    }
  )

  ipcMain.handle(
    'conversations:preserveTitle',
    async (_, input: ConversationTitleBackfillIdentity) => {
      if (!validBackfillIdentity(input)) throw new Error('Invalid title preservation identity')
      return { preserved: conversationTitles.preserve(input) }
    }
  )

  ipcMain.handle('conversations:delete', async (_, id: string) => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return { success: true }
  })

  ipcMain.handle('conversations:deleteAll', async () => {
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM conversations').run()
    return { success: true }
  })

  ipcMain.handle('conversations:getMessages', async (_, conversationId: string) => {
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    )
    const rows = stmt.all(conversationId) as Record<string, unknown>[]
    const runUsage = loadContextUsageByOutputMessage(db, conversationId)
    return rows.map((row) => {
      const { token_usage, checkpoint_hash, checkpoint_workspace_root, run_mode, ...rest } =
        row as Record<string, unknown>
      return {
        ...rest,
        segments: typeof row.segments === 'string' ? JSON.parse(row.segments) : undefined,
        tokenUsage: (() => {
          const persisted =
            typeof token_usage === 'string'
              ? (JSON.parse(token_usage) as Record<string, unknown>)
              : undefined
          const contextUsage = runUsage.get(String(row.id))
          if (!persisted && !contextUsage) return undefined
          return { ...(persisted ?? {}), ...(contextUsage ?? {}) }
        })(),
        checkpointHash: typeof checkpoint_hash === 'string' ? checkpoint_hash : undefined,
        checkpointWorkspaceRoot:
          typeof checkpoint_workspace_root === 'string' ? checkpoint_workspace_root : undefined,
        runMode:
          run_mode === 'research' ? 'research' : run_mode === 'plan' ? 'plan' : 'conversation'
      }
    })
  })

  ipcMain.handle('conversations:getLatestCompaction', async (_, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 100) {
      throw new Error('Invalid conversation ID')
    }
    return compactions.latest(conversationId)
  })

  ipcMain.handle(
    'conversations:saveCompaction',
    async (_, input: SaveConversationCompactionInput) => {
      const validOptionalText = (value: unknown, max: number): boolean =>
        value == null || (typeof value === 'string' && value.length <= max)
      const validCount = (value: unknown): boolean =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
      if (
        !input ||
        typeof input.conversationId !== 'string' ||
        !input.conversationId ||
        input.conversationId.length > 100 ||
        typeof input.summary !== 'string' ||
        !input.summary.trim() ||
        input.summary.length > 1_000_000 ||
        !validOptionalText(input.compactedThroughMessageId, 100) ||
        !validOptionalText(input.previousCompactionId, 100) ||
        !validCount(input.compactedThroughTimestamp ?? 0) ||
        !validCount(input.originalTokens) ||
        !validCount(input.summaryTokens) ||
        !Number.isInteger(input.messagesCompacted) ||
        input.messagesCompacted < 0 ||
        !['model', 'deterministic'].includes(input.strategy) ||
        typeof input.promptVersion !== 'string' ||
        input.promptVersion.length > 100 ||
        typeof input.provider !== 'string' ||
        input.provider.length > 100 ||
        typeof input.model !== 'string' ||
        input.model.length > 500
      ) {
        throw new Error('Invalid conversation compaction')
      }
      return compactions.save(input)
    }
  )

  ipcMain.handle('conversations:saveMessage', async (_, message: Record<string, unknown>) => {
    const stmt = db.prepare(
      `INSERT INTO messages
       (id, conversation_id, role, content, thinking, segments, token_usage,
        checkpoint_hash, checkpoint_workspace_root, run_mode, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const segmentsJson = message.segments ? JSON.stringify(message.segments) : null
    const tokenUsageJson = message.tokenUsage ? JSON.stringify(message.tokenUsage) : null
    stmt.run(
      message.id,
      message.conversation_id,
      message.role,
      message.content,
      message.thinking || null,
      segmentsJson,
      tokenUsageJson,
      message.checkpointHash || null,
      message.checkpointWorkspaceRoot || null,
      message.runMode === 'research'
        ? 'research'
        : message.runMode === 'plan'
          ? 'plan'
          : 'conversation',
      message.timestamp
    )

    const updateStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    updateStmt.run(Date.now(), message.conversation_id)

    return { success: true }
  })

  ipcMain.handle('conversations:updateMessage', async (_, message: Record<string, unknown>) => {
    const existing = db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(message.id) as
      | { timestamp: number }
      | undefined
    const stmt = db.prepare(
      `UPDATE messages
       SET content = ?, thinking = ?, segments = ?, token_usage = ?, checkpoint_hash = ?,
           checkpoint_workspace_root = ?, timestamp = ?
       WHERE id = ?`
    )
    const segmentsJson = message.segments ? JSON.stringify(message.segments) : null
    const tokenUsageJson = message.tokenUsage ? JSON.stringify(message.tokenUsage) : null
    stmt.run(
      message.content,
      message.thinking || null,
      segmentsJson,
      tokenUsageJson,
      message.checkpointHash || null,
      message.checkpointWorkspaceRoot || null,
      message.timestamp,
      message.id
    )

    const updateStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    updateStmt.run(Date.now(), message.conversation_id)
    if (existing) {
      compactions.invalidateFromTimestamp(String(message.conversation_id), existing.timestamp)
    }

    return { success: true }
  })

  ipcMain.handle(
    'conversations:deleteMessagesAfter',
    async (_, conversationId: string, timestamp: number) => {
      const stmt = db.prepare('DELETE FROM messages WHERE conversation_id = ? AND timestamp > ?')
      stmt.run(conversationId, timestamp)
      compactions.invalidateAfterTimestamp(conversationId, timestamp)

      const updateStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      updateStmt.run(Date.now(), conversationId)

      return { success: true }
    }
  )

  ipcMain.handle(
    'conversations:saveSkills',
    async (_, conversationId: string, skillIds: string[]) => {
      const stmt = db.prepare('UPDATE conversations SET active_skills = ? WHERE id = ?')
      stmt.run(JSON.stringify(skillIds), conversationId)
      return { success: true }
    }
  )

  ipcMain.handle('conversations:loadSkills', async (_, conversationId: string) => {
    const row = db
      .prepare('SELECT active_skills FROM conversations WHERE id = ?')
      .get(conversationId) as { active_skills: string | null } | undefined
    if (!row || !row.active_skills) return null
    try {
      return JSON.parse(row.active_skills) as string[]
    } catch {
      return null
    }
  })

  ipcMain.handle('memory:get', async (_, passedRoot?: string) => {
    try {
      const workspacePath = resolveKnownWorkspace(passedRoot)
      const row = db
        .prepare('SELECT content, updated_at FROM workspace_memory WHERE workspace_path = ?')
        .get(workspacePath) as { content: string; updated_at: number } | undefined
      return { ok: true, content: row?.content ?? '', updatedAt: row?.updated_at ?? null }
    } catch (error) {
      return { ok: false, content: '', updatedAt: null, error: (error as Error).message }
    }
  })

  ipcMain.handle('memory:save', async (_, passedRoot: string | undefined, content: string) => {
    try {
      const workspacePath = resolveKnownWorkspace(passedRoot)
      const normalized = content.trim().slice(0, 64_000)
      const updatedAt = Date.now()
      db.prepare(
        `INSERT INTO workspace_memory (workspace_path, content, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).run(workspacePath, normalized, updatedAt)
      return { ok: true, content: normalized, updatedAt }
    } catch (error) {
      return { ok: false, content: '', updatedAt: null, error: (error as Error).message }
    }
  })
}
