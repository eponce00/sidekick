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

  it('adds a new message column to a database that already applied every earlier migration', async () => {
    // Required columns are only reconciled inside a migration. A column listed
    // without one of its own never reached an installed database, which then
    // refused to store a goal's completion notice.
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-upgrade-'))
    let disk: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      disk = openApplicationDatabase(path)
      disk
        .prepare("DELETE FROM schema_migrations WHERE id = '20260923_001_message_notice_tone'")
        .run()
      disk.exec('ALTER TABLE messages DROP COLUMN notice_tone')
      disk.close()

      disk = openApplicationDatabase(path)
      const columns = (
        disk.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      ).map(({ name }) => name)
      expect(columns).toContain('notice_tone')
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('turns each group chat into a manager chat with worker chats and drops group tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-groups-'))
    let disk: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      disk = openApplicationDatabase(path)
      disk
        .prepare("DELETE FROM schema_migrations WHERE id = '20261016_004_group_chats_to_chats'")
        .run()
      // The group tables as the last release stored them, with one group of two agents.
      disk.exec(`
        CREATE TABLE collaboration_groups (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, unread_completion_at INTEGER);
        CREATE TABLE collaboration_participants (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, project_id TEXT NOT NULL, label TEXT NOT NULL,
          provider_target_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          joined_at INTEGER NOT NULL, removed_at INTEGER, last_read_seq INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT);
        CREATE TABLE collaboration_agent_sessions (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, participant_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_completion_at INTEGER,
          FOREIGN KEY (participant_id) REFERENCES collaboration_participants(id) ON DELETE CASCADE);
        CREATE TABLE collaboration_agent_session_messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mission_id TEXT, role TEXT NOT NULL,
          kind TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls_json TEXT,
          tool_call_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES collaboration_agent_sessions(id) ON DELETE CASCADE);
        CREATE TABLE collaboration_events (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, mission_id TEXT, seq INTEGER NOT NULL,
          actor_type TEXT NOT NULL, actor_participant_id TEXT, kind TEXT NOT NULL,
          payload_json TEXT NOT NULL, reply_to_event_id TEXT, idempotency_key TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE);
        INSERT INTO projects (id, name, folder_path, created_at, updated_at)
          VALUES ('demo', 'sidekick-demo', '/p/demo', 1, 1), ('api', 'sidekick-api', '/p/api', 1, 1);
        INSERT INTO collaboration_groups VALUES ('g1', 'Desktop + API launch', NULL, 'active', 10, 50, NULL);
        INSERT INTO collaboration_participants VALUES
          ('p1', 'g1', 'demo', 'Desktop client', '{}', 'active', 11, NULL, 0),
          ('p2', 'g1', 'api', 'API endpoint', '{}', 'active', 12, NULL, 0);
        INSERT INTO collaboration_agent_sessions VALUES
          ('s1', 'g1', 'p1', 'demo', 'Desktop client', 0, 11, 50, NULL),
          ('s2', 'g1', 'p2', 'api', 'API endpoint', 0, 12, 50, NULL);
        INSERT INTO collaboration_agent_session_messages VALUES
          ('m1', 's2', NULL, 'assistant', 'text', 'Contract test added.', NULL, NULL, '{}', 30),
          ('m2', 's2', NULL, 'tool', 'tool_result', '{"ok":true}', NULL, 'c1', '{}', 31);
        INSERT INTO collaboration_events VALUES
          ('e1', 'g1', NULL, 1, 'user', NULL, 'user_message', '{"text":"Agree on the contract."}', NULL, NULL, 20),
          ('e2', 'g1', NULL, 2, 'agent', 'p1', 'peer_message', '{"text":"Shape of /v1/projects?","metadata":{"messageType":"request"}}', NULL, NULL, 21),
          ('e3', 'g1', NULL, 3, 'agent', 'p2', 'agent_activity', '{"text":"Running tests"}', NULL, NULL, 22),
          ('e4', 'g1', NULL, 4, 'agent', 'p2', 'peer_message', '{"text":"{ projects, nextCursor }","metadata":{"messageType":"response"}}', NULL, NULL, 23);
        INSERT INTO agent_runs (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
          VALUES ('collab-run', 's2', 'collaboration', 'completed', 'p', 'm', '{}', 1, 1);
      `)
      disk.close()

      disk = openApplicationDatabase(path)
      expect(
        disk.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'collaboration_%'").all()
      ).toEqual([])
      expect(
        disk
          .prepare("SELECT count(*) AS count FROM agent_runs WHERE surface = 'collaboration'")
          .get()
      ).toEqual({ count: 0 })
      const manager = disk.prepare("SELECT * FROM conversations WHERE id = 'g1'").get() as Record<
        string,
        unknown
      >
      expect(manager).toMatchObject({
        title: 'Desktop + API launch',
        project_id: null,
        started_by_conversation_id: null
      })
      const workers = disk
        .prepare(
          'SELECT * FROM conversations WHERE started_by_conversation_id = ? ORDER BY created_at'
        )
        .all('g1') as Array<Record<string, unknown>>
      expect(
        workers.map(({ session_handle, project_id, work_in }) => [
          session_handle,
          project_id,
          work_in
        ])
      ).toEqual([
        ['desktop-client', 'demo', 'folder'],
        ['api-endpoint', 'api', 'folder']
      ])
      expect(
        disk
          .prepare(
            'SELECT project_id FROM session_project_grants WHERE conversation_id = ? ORDER BY project_id'
          )
          .all('g1')
      ).toEqual([{ project_id: 'api' }, { project_id: 'demo' }])
      // The shared timeline stays readable in the manager: the person's message, then each post.
      expect(
        disk
          .prepare(
            "SELECT role, content FROM messages WHERE conversation_id = 'g1' ORDER BY timestamp"
          )
          .all()
      ).toEqual([
        { role: 'system', content: expect.stringContaining('Converted from the group chat') },
        { role: 'user', content: 'Agree on the contract.' }
      ])
      expect(
        disk
          .prepare(
            "SELECT intent, body, delivered_at IS NOT NULL AS delivered FROM session_messages WHERE to_conversation_id = 'g1' ORDER BY created_at"
          )
          .all()
      ).toEqual([
        { intent: 'request', body: 'Shape of /v1/projects?', delivered: 1 },
        { intent: 'response', body: '{ projects, nextCursor }', delivered: 1 }
      ])
      expect(
        disk
          .prepare('SELECT role, content FROM messages WHERE conversation_id = ?')
          .all(workers[1].id)
      ).toEqual([{ role: 'agent', content: 'Contract test added.' }])
      expect(disk.pragma('foreign_key_check')).toEqual([])
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds family links, messages, proposals and grants to an installed database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-sessions-'))
    let disk: Database.Database | undefined
    try {
      // A chat table from before families: every link column arrives through ALTER TABLE.
      const path = join(root, 'app.db')
      disk = new Database(path)
      disk.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO conversations VALUES ('manager', 'Manager', 1, 1);
      `)
      disk.close()

      disk = openApplicationDatabase(path)
      const columns = (
        disk.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
      ).map(({ name }) => name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'started_by_kind',
          'started_by_conversation_id',
          'report_to_conversation_id',
          'session_handle',
          'work_in',
          'archived_at'
        ])
      )
      expect(
        disk.prepare("SELECT started_by_kind FROM conversations WHERE id = 'manager'").get()
      ).toEqual({ started_by_kind: 'user' })
      expect(
        disk
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_%' ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: 'session_attachments' },
        { name: 'session_messages' },
        { name: 'session_project_grants' },
        { name: 'session_proposals' }
      ])

      const addWorker = disk.prepare(`
        INSERT INTO conversations
          (id, title, created_at, updated_at, started_by_kind, started_by_conversation_id,
           report_to_conversation_id, session_handle, work_in)
        VALUES (?, ?, 2, 2, 'session', 'manager', 'manager', ?, 'worktree')
      `)
      addWorker.run('worker-1', 'Schedules', 'schedules')
      expect(() => addWorker.run('worker-2', 'Schedules again', 'schedules')).toThrow(/UNIQUE/)
      disk
        .prepare(
          `INSERT INTO session_messages (id, from_conversation_id, to_conversation_id, intent, body, created_at)
           VALUES ('report-1', 'worker-1', 'manager', 'report', 'Done.', 3)`
        )
        .run()
      expect(() =>
        disk!
          .prepare(
            `INSERT INTO session_messages (id, to_conversation_id, intent, body, created_at)
             VALUES ('bad', 'manager', 'approve', 'Approve it', 4)`
          )
          .run()
      ).toThrow(/CHECK/)

      // Deleting a manager detaches its workers; messages addressed to it go with it.
      disk.prepare("DELETE FROM conversations WHERE id = 'manager'").run()
      expect(
        disk
          .prepare(
            "SELECT started_by_conversation_id, report_to_conversation_id FROM conversations WHERE id = 'worker-1'"
          )
          .get()
      ).toEqual({ started_by_conversation_id: null, report_to_conversation_id: null })
      expect(disk.prepare('SELECT count(*) AS count FROM session_messages').get()).toEqual({
        count: 0
      })
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds schedules and the schedule columns on chats to an installed database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-db-schedules-'))
    let disk: Database.Database | undefined
    try {
      const path = join(root, 'app.db')
      disk = openApplicationDatabase(path)
      disk.prepare("DELETE FROM schema_migrations WHERE id = '20261016_001_schedules'").run()
      disk.exec(`
        DROP TABLE schedule_runs;
        DROP TABLE schedules;
        ALTER TABLE conversations DROP COLUMN schedule_id;
        ALTER TABLE conversations DROP COLUMN schedule_run_number;
        INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('kept', 'Keep me', 1, 1);
      `)
      disk.close()

      disk = openApplicationDatabase(path)
      const columns = (
        disk.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
      ).map(({ name }) => name)
      expect(columns).toEqual(expect.arrayContaining(['schedule_id', 'schedule_run_number']))
      expect(
        disk
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schedules', 'schedule_runs') ORDER BY name"
          )
          .all()
      ).toEqual([{ name: 'schedule_runs' }, { name: 'schedules' }])
      expect(disk.prepare('SELECT schedule_id FROM conversations').get()).toEqual({
        schedule_id: null
      })
    } finally {
      if (disk?.open) disk.close()
      await rm(root, { recursive: true, force: true })
    }
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
        count: 13
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
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'collaboration_%'").all()
    ).toEqual([])
    expect(messageColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['run_mode', 'images', 'attachments', 'notice_tone', 'starts_goal'])
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
      { id: '20260830_004_message_context_attachments', checksum_length: 64 },
      { id: '20260923_001_message_notice_tone', checksum_length: 64 },
      { id: '20260923_002_message_goal_origin', checksum_length: 64 },
      { id: '20261016_001_schedules', checksum_length: 64 },
      { id: '20261016_002_worktree_base_ref', checksum_length: 64 },
      { id: '20261016_003_sessions', checksum_length: 64 },
      { id: '20261016_004_group_chats_to_chats', checksum_length: 64 }
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
