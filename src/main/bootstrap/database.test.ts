import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema, openApplicationDatabase } from './database'
import { mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('database schema migrations', () => {
  it('refuses a newer migration ledger without changing schema or data', () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.exec("INSERT INTO schema_migrations VALUES ('20990101_future', 'future', 1)")
    db.exec('DROP TABLE workspace_memory')
    const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    expect(() => applyDatabaseSchema(db!)).toThrow('unsupported migration')
    expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before)
  })

  it('rolls back the entire schema upgrade when a later migration fails, then retries cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-fault-'))
    let disk: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      disk = new Database(path)
      disk.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO conversations VALUES ('fixture', 'Keep me', 1, 1);
        CREATE TABLE conversation_runs (id TEXT PRIMARY KEY);
        INSERT INTO conversation_runs VALUES ('legacy-run');
        CREATE TABLE agent_prompt_admissions (conflict TEXT);
      `)
      const before = disk.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
      disk.close()
      expect(() => openApplicationDatabase(path)).toThrow('already exists')
      disk = new Database(path)
      expect(disk.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before)
      expect(disk.prepare('SELECT * FROM conversation_runs').all()).toEqual([{ id: 'legacy-run' }])
      expect(disk.prepare('SELECT title FROM conversations').get()).toEqual({ title: 'Keep me' })
      disk.exec('DROP TABLE agent_prompt_admissions')
      disk.close()
      disk = openApplicationDatabase(path)
      expect(disk.prepare('SELECT title FROM conversations').get()).toEqual({ title: 'Keep me' })
      expect(disk.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({
        count: 7
      })
      expect(disk.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('backs up pending upgrades even when a migration ledger already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-upgrade-'))
    let disk: Database.Database | undefined
    let backup: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      disk = openApplicationDatabase(path)
      const missing = '20260830_003_title_backfill_attempt_versions'
      disk.prepare('DELETE FROM schema_migrations WHERE id = ?').run(missing)
      disk.close()
      disk = openApplicationDatabase(path)
      const backups = (await readdir(root)).filter((name) => name.endsWith('.bak'))
      expect(backups).toHaveLength(1)
      backup = new Database(join(root, backups[0]), { readonly: true })
      expect(
        backup.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(missing)
      ).toBeUndefined()
      expect(
        disk.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(missing)
      ).toBeDefined()
      disk.close()
      disk = openApplicationDatabase(path)
      expect((await readdir(root)).filter((name) => name.endsWith('.bak'))).toEqual(backups)
    } finally {
      if (backup?.open) backup.close()
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })
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
        'title_backfill_attempted_version',
        'title_backfill_error',
        'unread_completion_at',
        'forked_from_conversation_id',
        'forked_from_message_id'
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
    expect(messageColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['run_mode', 'images', 'attachments'])
    )
    expect(
      db.prepare('SELECT id, length(checksum) AS checksum_length FROM schema_migrations').all()
    ).toEqual([
      { id: '20260829_001_canonical_runtime', checksum_length: 64 },
      { id: '20260829_002_prompt_admission', checksum_length: 64 },
      { id: '20260829_003_journal_materializations', checksum_length: 64 },
      { id: '20260830_001_managed_worktrees', checksum_length: 64 },
      { id: '20260830_002_conversation_pins', checksum_length: 64 },
      { id: '20260830_003_title_backfill_attempt_versions', checksum_length: 64 },
      { id: '20260830_004_message_context_attachments', checksum_length: 64 }
    ])
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_worktrees'"
        )
        .get()
    ).toEqual({ name: 'managed_worktrees' })
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

  it('refuses to start when an applied migration checksum was altered', () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.prepare('UPDATE schema_migrations SET checksum = ?').run('tampered')
    db.exec('DROP TABLE workspace_memory')
    const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    expect(() => applyDatabaseSchema(db!)).toThrow('Database migration checksum mismatch')
    expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before)
  })

  it('upgrades legacy label-only checksums without replaying migrations', () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    const id = '20260830_003_title_backfill_attempt_versions'
    const description = 'retry title generation immediately when its algorithm version changes'
    const legacyChecksum = createHash('sha256').update(`${id}\n${description}`).digest('hex')
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE id = ?').run(legacyChecksum, id)

    expect(() => applyDatabaseSchema(db!)).not.toThrow()
    const current = db.prepare('SELECT checksum FROM schema_migrations WHERE id = ?').get(id) as {
      checksum: string
    }
    expect(current.checksum).toHaveLength(64)
    expect(current.checksum).not.toBe(legacyChecksum)
  })

  it('adds the run materialization index only after upgrading legacy messages', () => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `)

    expect(() => applyDatabaseSchema(db!)).not.toThrow()
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    const indexes = db.prepare('PRAGMA index_list(messages)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toContain('run_id')
    expect(indexes.map(({ name }) => name)).toContain('idx_messages_run_materialization')
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
