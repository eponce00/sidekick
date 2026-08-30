import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync } from 'fs'

type ColumnRow = { name: string }

const REQUIRED_COLUMNS = [
  { table: 'messages', column: 'segments', definition: 'TEXT' },
  { table: 'messages', column: 'images', definition: 'TEXT' },
  { table: 'messages', column: 'attachments', definition: 'TEXT' },
  { table: 'messages', column: 'token_usage', definition: 'TEXT' },
  { table: 'messages', column: 'checkpoint_hash', definition: 'TEXT' },
  { table: 'messages', column: 'run_id', definition: 'TEXT' },
  { table: 'conversations', column: 'active_skills', definition: 'TEXT' },
  { table: 'conversations', column: 'project_id', definition: 'TEXT' },
  { table: 'conversations', column: 'is_pinned', definition: 'INTEGER NOT NULL DEFAULT 0' },
  {
    table: 'conversations',
    column: 'title_source',
    definition: "TEXT NOT NULL DEFAULT 'legacy'"
  },
  {
    table: 'conversations',
    column: 'title_version',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  },
  { table: 'conversations', column: 'title_backfill_attempted_at', definition: 'INTEGER' },
  {
    table: 'conversations',
    column: 'title_backfill_attempted_version',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  },
  { table: 'conversations', column: 'title_backfill_error', definition: 'TEXT' },
  { table: 'conversations', column: 'sidebar_order', definition: 'INTEGER NOT NULL DEFAULT 0' },
  {
    table: 'conversations',
    column: 'project_context_version',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  },
  { table: 'conversations', column: 'home_workspace_root', definition: 'TEXT' },
  { table: 'conversations', column: 'home_project_name', definition: 'TEXT' },
  { table: 'conversations', column: 'unread_completion_at', definition: 'INTEGER' },
  { table: 'conversations', column: 'forked_from_conversation_id', definition: 'TEXT' },
  { table: 'conversations', column: 'forked_from_message_id', definition: 'TEXT' },
  { table: 'collaboration_groups', column: 'unread_completion_at', definition: 'INTEGER' },
  {
    table: 'collaboration_agent_sessions',
    column: 'unread_completion_at',
    definition: 'INTEGER'
  },
  { table: 'messages', column: 'checkpoint_workspace_root', definition: 'TEXT' },
  {
    table: 'messages',
    column: 'run_mode',
    definition: "TEXT NOT NULL DEFAULT 'conversation'"
  },
  { table: 'background_tasks', column: 'run_id', definition: "TEXT NOT NULL DEFAULT 'user'" },
  { table: 'background_tasks', column: 'cwd', definition: "TEXT NOT NULL DEFAULT ''" },
  {
    table: 'conversation_compactions',
    column: 'strategy',
    definition: "TEXT NOT NULL DEFAULT 'model'"
  },
  {
    table: 'conversation_compactions',
    column: 'prompt_version',
    definition: "TEXT NOT NULL DEFAULT 'legacy'"
  },
  {
    table: 'conversation_compactions',
    column: 'provider',
    definition: "TEXT NOT NULL DEFAULT 'unknown'"
  },
  {
    table: 'conversation_compactions',
    column: 'model',
    definition: "TEXT NOT NULL DEFAULT 'unknown'"
  },
  {
    table: 'conversation_goals',
    column: 'prompt_tokens',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  },
  {
    table: 'conversation_goals',
    column: 'completion_tokens',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  }
] as const

function ensureRequiredColumns(db: Database.Database): void {
  const columnsByTable = new Map<string, Set<string>>()
  for (const migration of REQUIRED_COLUMNS) {
    let columns = columnsByTable.get(migration.table)
    if (!columns) {
      columns = new Set(
        (db.prepare(`PRAGMA table_info(${migration.table})`).all() as ColumnRow[]).map(
          ({ name }) => name
        )
      )
      columnsByTable.set(migration.table, columns)
    }
    if (columns.has(migration.column)) continue
    db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`)
    columns.add(migration.column)
    console.log(`[Database] Added ${migration.table}.${migration.column}`)
  }
}

interface SchemaMigration {
  id: string
  description: string
  /** Immutable identifier for the exact operations in this migration. Never reuse after edits. */
  contentId: string
  apply: (db: Database.Database) => void
}

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: '20260829_001_canonical_runtime',
    description: 'reconcile legacy columns and retire transient conversation run state',
    contentId: 'v1|required-columns|drop-conversation-runs|backfill-project-affinity',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec('DROP TABLE IF EXISTS conversation_runs')
      db.exec(`
        UPDATE conversations
        SET home_workspace_root = (
              SELECT folder_path FROM projects WHERE projects.id = conversations.project_id
            ),
            home_project_name = (
              SELECT name FROM projects WHERE projects.id = conversations.project_id
            )
        WHERE project_id IS NOT NULL AND home_workspace_root IS NULL;
      `)
    }
  },
  {
    id: '20260829_002_prompt_admission',
    description: 'persist queued and pivot prompts with transactional admission',
    contentId: 'v1|agent-prompt-admissions-table|order-and-pivot-indexes',
    apply: (db) => {
      db.exec(`
        CREATE TABLE agent_prompt_admissions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          content TEXT NOT NULL,
          images_json TEXT,
          attachments_json TEXT,
          mode TEXT NOT NULL,
          behavior TEXT NOT NULL CHECK (behavior IN ('pivot', 'queue')),
          position INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_agent_prompt_admissions_order
          ON agent_prompt_admissions(conversation_id, behavior, position, created_at);
        CREATE UNIQUE INDEX idx_agent_prompt_admissions_pivot
          ON agent_prompt_admissions(conversation_id)
          WHERE behavior = 'pivot';
      `)
    }
  },
  {
    id: '20260829_003_journal_materializations',
    description: 'link assistant message materializations to their authoritative agent run journal',
    contentId: 'v1|required-columns|unique-message-run-materialization-index',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_run_materialization
          ON messages(run_id)
          WHERE run_id IS NOT NULL;
      `)
    }
  },
  {
    id: '20260830_001_managed_worktrees',
    description: 'track conversation fork lineage and SideKick-managed Git worktrees',
    contentId: 'v1|required-columns|managed-worktrees-table|age-index',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec(`
        CREATE TABLE IF NOT EXISTS managed_worktrees (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL UNIQUE,
          source_project_id TEXT NOT NULL,
          repository_root TEXT NOT NULL,
          worktree_root TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_managed_worktrees_age
          ON managed_worktrees(last_used_at ASC, created_at ASC);
      `)
    }
  },
  {
    id: '20260830_002_conversation_pins',
    description: 'persist pinned conversations and order them ahead of unpinned chats',
    contentId: 'v1|required-columns|pinned-conversation-order-index',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_pinned_order
          ON conversations(is_pinned DESC, project_id, sidebar_order, updated_at DESC);
      `)
    }
  },
  {
    id: '20260830_003_title_backfill_attempt_versions',
    description: 'retry title generation immediately when its algorithm version changes',
    contentId: 'v1|required-title-backfill-attempt-version-column',
    apply: (db) => {
      ensureRequiredColumns(db)
    }
  },
  {
    id: '20260830_004_message_context_attachments',
    description: 'persist typed project file and folder references on messages and queued prompts',
    contentId: 'v1|required-message-and-admission-attachment-columns',
    apply: (db) => {
      ensureRequiredColumns(db)
      const admissionColumns = new Set(
        (db.prepare('PRAGMA table_info(agent_prompt_admissions)').all() as ColumnRow[]).map(
          ({ name }) => name
        )
      )
      if (!admissionColumns.has('attachments_json')) {
        db.exec('ALTER TABLE agent_prompt_admissions ADD COLUMN attachments_json TEXT')
      }
    }
  }
]

function migrationChecksum(migration: SchemaMigration): string {
  return createHash('sha256')
    .update(`${migration.id}\n${migration.description}\n${migration.contentId}`)
    .digest('hex')
}

function legacyMigrationChecksum(migration: SchemaMigration): string {
  return createHash('sha256').update(`${migration.id}\n${migration.description}`).digest('hex')
}

function applyVersionedMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const applied = new Map(
    (
      db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as Array<{
        id: string
        checksum: string
      }>
    ).map((migration) => [migration.id, migration.checksum])
  )
  const checksumUpgrades: Array<{ id: string; previous: string; checksum: string }> = []
  for (const migration of SCHEMA_MIGRATIONS) {
    const checksum = migrationChecksum(migration)
    const prior = applied.get(migration.id)
    if (prior && prior !== checksum && prior !== legacyMigrationChecksum(migration)) {
      throw new Error(`Database migration checksum mismatch: ${migration.id}`)
    }
    if (prior && prior !== checksum) {
      checksumUpgrades.push({ id: migration.id, previous: prior, checksum })
    }
  }
  db.transaction(() => {
    const update = db.prepare(
      'UPDATE schema_migrations SET checksum = ? WHERE id = ? AND checksum = ?'
    )
    for (const migration of checksumUpgrades) {
      const result = update.run(migration.checksum, migration.id, migration.previous)
      if (result.changes !== 1) {
        throw new Error(`Database migration checksum changed during upgrade: ${migration.id}`)
      }
    }
  })()

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.id)) continue
    const checksum = migrationChecksum(migration)
    db.transaction(() => {
      migration.apply(db)
      db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        checksum,
        Date.now()
      )
    })()
  }
}

export function applyDatabaseSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder_path TEXT NOT NULL UNIQUE,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      active_skills TEXT,
      project_id TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      title_source TEXT NOT NULL DEFAULT 'legacy',
      title_version INTEGER NOT NULL DEFAULT 0,
      title_backfill_attempted_at INTEGER,
      title_backfill_attempted_version INTEGER NOT NULL DEFAULT 0,
      title_backfill_error TEXT,
      sidebar_order INTEGER NOT NULL DEFAULT 0,
      project_context_version INTEGER NOT NULL DEFAULT 0,
      home_workspace_root TEXT,
      home_project_name TEXT,
      unread_completion_at INTEGER,
      forked_from_conversation_id TEXT,
      forked_from_message_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      source_project_id TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      worktree_root TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      segments TEXT,
      images TEXT,
      attachments TEXT,
      token_usage TEXT,
      run_id TEXT,
      checkpoint_hash TEXT,
      checkpoint_workspace_root TEXT,
      run_mode TEXT NOT NULL DEFAULT 'conversation',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_role_timestamp
      ON messages(conversation_id, role, timestamp);

    CREATE TABLE IF NOT EXISTS conversation_compactions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      compacted_through_message_id TEXT,
      compacted_through_timestamp INTEGER,
      previous_compaction_id TEXT,
      original_tokens INTEGER NOT NULL,
      summary_tokens INTEGER NOT NULL,
      messages_compacted INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (previous_compaction_id) REFERENCES conversation_compactions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_compactions_latest
      ON conversation_compactions(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_memory (
      workspace_path TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      result_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_background_tasks_started
      ON background_tasks(started_at DESC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      parent_run_id TEXT,
      surface TEXT NOT NULL,
      phase TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      workspace_root TEXT,
      profile_json TEXT NOT NULL,
      prompt_context_json TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_json TEXT,
      FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_thread
      ON agent_runs(thread_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_agent_runs_phase
      ON agent_runs(phase, updated_at);

    CREATE TABLE IF NOT EXISTS agent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE(run_id, sequence),
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run
      ON agent_run_events(run_id, sequence);

    CREATE TABLE IF NOT EXISTS workspace_verification_state (
      workspace_root TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_change_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_change_events_revision
      ON workspace_change_events(workspace_root, revision ASC);

    CREATE TABLE IF NOT EXISTS workspace_verification_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT,
      cwd TEXT,
      exit_code INTEGER,
      summary TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL,
      fingerprint TEXT,
      diagnostics_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_verification_events_revision
      ON workspace_verification_events(workspace_root, revision DESC, completed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workspace_verification_events_run
      ON workspace_verification_events(run_id, completed_at ASC);

    CREATE TABLE IF NOT EXISTS agent_pending_interactions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      request_json TEXT NOT NULL,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_pending_interactions_run
      ON agent_pending_interactions(run_id, status, created_at);

    CREATE TABLE IF NOT EXISTS agent_run_todos (
      run_id TEXT PRIMARY KEY,
      todo_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_run_plans (
      run_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      planner_model TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      revision TEXT,
      contract_json TEXT,
      completion_json TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_goals (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      continuation_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      blocked_streak INTEGER NOT NULL DEFAULT 0,
      blocked_key TEXT,
      plan_json TEXT NOT NULL DEFAULT '[]',
      completion_summary TEXT,
      completion_verification TEXT,
      status_reason TEXT,
      current_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (current_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_goals_current
      ON conversation_goals(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_goal_events (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES conversation_goals(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_goal_events
      ON conversation_goal_events(goal_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS checkpoint_labels (
      workspace_root TEXT NOT NULL,
      checkpoint_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      label_source TEXT NOT NULL DEFAULT 'legacy',
      label_version INTEGER NOT NULL DEFAULT 0,
      backfill_attempted_at INTEGER,
      backfill_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_root, checkpoint_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoint_label_backfill
      ON checkpoint_labels(workspace_root, label_source, label_version, backfill_attempted_at);

    CREATE TABLE IF NOT EXISTS conversation_project_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      from_project_id TEXT,
      to_project_id TEXT,
      from_project_name TEXT,
      to_project_name TEXT,
      from_workspace_root TEXT,
      to_workspace_root TEXT,
      moved_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_project_events_latest
      ON conversation_project_events(conversation_id, moved_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_groups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      unread_completion_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS collaboration_participants (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      provider_target_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at INTEGER NOT NULL,
      removed_at INTEGER,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_participant_project
      ON collaboration_participants(group_id, project_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_collaboration_participants_group
      ON collaboration_participants(group_id, status, joined_at);

    CREATE TABLE IF NOT EXISTS collaboration_agent_sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      participant_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      unread_completion_at INTEGER,
      FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES collaboration_participants(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_agent_sessions_group
      ON collaboration_agent_sessions(group_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_agent_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      mission_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls_json TEXT,
      tool_call_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES collaboration_agent_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (mission_id) REFERENCES collaboration_missions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_session_messages
      ON collaboration_agent_session_messages(session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS collaboration_missions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      objective_event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_participants_json TEXT NOT NULL,
      round_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT,
      FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_missions_group
      ON collaboration_missions(group_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS collaboration_participant_runs (
      mission_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      iteration_count INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 1000,
      last_ingested_seq INTEGER NOT NULL DEFAULT 0,
      current_activity TEXT,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT,
      PRIMARY KEY (mission_id, participant_id),
      FOREIGN KEY (mission_id) REFERENCES collaboration_missions(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES collaboration_participants(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_participant_runs_mission
      ON collaboration_participant_runs(mission_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS collaboration_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      mission_id TEXT,
      seq INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      actor_participant_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reply_to_event_id TEXT,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (mission_id) REFERENCES collaboration_missions(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_participant_id) REFERENCES collaboration_participants(id) ON DELETE SET NULL,
      FOREIGN KEY (reply_to_event_id) REFERENCES collaboration_events(id) ON DELETE SET NULL,
      UNIQUE (group_id, seq),
      UNIQUE (idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_events_group
      ON collaboration_events(group_id, seq);

    CREATE INDEX IF NOT EXISTS idx_collaboration_events_mission
      ON collaboration_events(mission_id, seq);

    CREATE TABLE IF NOT EXISTS collaboration_deliveries (
      event_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      delivered_at INTEGER,
      consumed_at INTEGER,
      wake_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, participant_id),
      FOREIGN KEY (event_id) REFERENCES collaboration_events(id) ON DELETE CASCADE,
      FOREIGN KEY (participant_id) REFERENCES collaboration_participants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collaboration_artifacts (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      mission_id TEXT,
      sender_participant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES collaboration_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (mission_id) REFERENCES collaboration_missions(id) ON DELETE SET NULL,
      FOREIGN KEY (sender_participant_id) REFERENCES collaboration_participants(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_group
      ON collaboration_artifacts(group_id, created_at DESC);
  `)

  applyVersionedMigrations(db)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_background_tasks_run
      ON background_tasks(run_id, started_at DESC);
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_project
      ON conversations(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_title_backfill
      ON conversations(title_source, title_version, title_backfill_attempted_at);

    CREATE INDEX IF NOT EXISTS idx_conversation_title_backfill_v2
      ON conversations(
        title_source,
        title_version,
        title_backfill_attempted_version,
        title_backfill_attempted_at
      );

    CREATE INDEX IF NOT EXISTS idx_conversation_sidebar_order
      ON conversations(project_id, sidebar_order, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversations_pinned_order
      ON conversations(is_pinned DESC, project_id, sidebar_order, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_home_workspace
      ON conversations(home_workspace_root);

    CREATE INDEX IF NOT EXISTS idx_projects_activity
      ON projects(is_pinned DESC, updated_at DESC);
  `)
}

export function openApplicationDatabase(path: string): Database.Database {
  const existed = path !== ':memory:' && existsSync(path)
  const db = new Database(path)
  try {
    const hasMigrationLedger = Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get()
    )
    if (existed && !hasMigrationLedger) {
      const backupPath = `${path}.pre-versioned-migrations-${Date.now()}.bak`
      db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
      console.log(`[Database] Created pre-migration backup: ${backupPath}`)
    }
    applyDatabaseSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
