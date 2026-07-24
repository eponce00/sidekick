import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from './database'

describe('database schema migrations', () => {
  let db: Database.Database | null = null

  afterEach(() => db?.close())

  it('removes pre-kernel run state and adds canonical run and compaction provenance', () => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversation_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_message_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        partial_content TEXT NOT NULL DEFAULT '',
        pending_tool_json TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT
      );
      CREATE TABLE conversation_compactions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        compacted_through_message_id TEXT,
        compacted_through_timestamp INTEGER,
        previous_compaction_id TEXT,
        original_tokens INTEGER NOT NULL,
        summary_tokens INTEGER NOT NULL,
        messages_compacted INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    applyDatabaseSchema(db)

    const legacyRunColumns = db.prepare('PRAGMA table_info(conversation_runs)').all() as Array<{
      name: string
    }>
    const runColumns = db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>
    const compactionColumns = db
      .prepare('PRAGMA table_info(conversation_compactions)')
      .all() as Array<{ name: string }>
    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{
      name: string
    }>
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string
    }>
    expect(legacyRunColumns).toEqual([])
    expect(runColumns.map(({ name }) => name)).toContain('prompt_context_json')
    expect(compactionColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['strategy', 'prompt_version', 'provider', 'model'])
    )
    expect(conversationColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'title_source',
        'title_version',
        'title_backfill_attempted_at',
        'title_backfill_error',
        'unread_completion_at'
      ])
    )
    const groupColumns = db.prepare('PRAGMA table_info(collaboration_groups)').all() as Array<{
      name: string
    }>
    const agentSessionColumns = db
      .prepare('PRAGMA table_info(collaboration_agent_sessions)')
      .all() as Array<{ name: string }>
    expect(groupColumns.map(({ name }) => name)).toContain('unread_completion_at')
    expect(agentSessionColumns.map(({ name }) => name)).toContain('unread_completion_at')
    expect(messageColumns.map(({ name }) => name)).toContain('run_mode')
    const checkpointLabelColumns = db
      .prepare('PRAGMA table_info(checkpoint_labels)')
      .all() as Array<{
      name: string
    }>
    expect(checkpointLabelColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'workspace_root',
        'checkpoint_hash',
        'label',
        'label_source',
        'label_version',
        'backfill_attempted_at'
      ])
    )
  })

  it('backfills permanent folder affinity for legacy attached project chats', () => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder_path TEXT NOT NULL UNIQUE,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        project_id TEXT
      );
      INSERT INTO projects VALUES ('project-1', 'Legacy', '/tmp/legacy', 0, 1, 1);
      INSERT INTO conversations VALUES ('conversation-1', 'Legacy chat', 1, 1, 'project-1');
    `)

    applyDatabaseSchema(db)

    expect(
      db
        .prepare(
          `SELECT home_workspace_root, home_project_name
           FROM conversations WHERE id = 'conversation-1'`
        )
        .get()
    ).toEqual({ home_workspace_root: '/tmp/legacy', home_project_name: 'Legacy' })
  })
})
