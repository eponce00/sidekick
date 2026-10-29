import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { convertGroupChats } from './groupChatMigration'

type ColumnRow = { name: string }

const REQUIRED_COLUMNS = [
  { table: 'messages', column: 'segments', definition: 'TEXT' },
  { table: 'messages', column: 'images', definition: 'TEXT' },
  { table: 'messages', column: 'attachments', definition: 'TEXT' },
  { table: 'messages', column: 'token_usage', definition: 'TEXT' },
  { table: 'messages', column: 'checkpoints', definition: 'TEXT' },
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
  { table: 'managed_worktrees', column: 'base_ref', definition: 'TEXT' },
  { table: 'managed_worktrees', column: 'set_aside_at', definition: 'INTEGER' },
  { table: 'managed_worktrees', column: 'set_aside_head', definition: 'TEXT' },
  { table: 'managed_worktrees', column: 'set_aside_branch', definition: 'TEXT' },
  { table: 'managed_worktrees', column: 'snapshot_commit', definition: 'TEXT' },
  { table: 'managed_worktrees', column: 'folder_path', definition: 'TEXT' },
  { table: 'conversations', column: 'worktree_id', definition: 'TEXT' },
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
  // How far into the reply that follows its anchor a summary reaches, in that reply's provider
  // messages, so the next run does not send again the turns the summary replaced.
  { table: 'conversation_compactions', column: 'reply_message_id', definition: 'TEXT' },
  {
    table: 'conversation_compactions',
    column: 'reply_messages_covered',
    definition: 'INTEGER NOT NULL DEFAULT 0'
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
  },
  {
    // App-authored status presentation for a system notice, so a goal that
    // finished still reads as finished after the conversation is reopened.
    table: 'messages',
    column: 'notice_tone',
    definition: 'TEXT'
  },
  {
    // Marks the message a persistent goal began from, so retrying or editing it
    // starts the goal again instead of sending it as an ordinary message.
    table: 'messages',
    column: 'starts_goal',
    definition: 'INTEGER NOT NULL DEFAULT 0'
  },
  // The schedule that created a chat, and its run number, so the sidebar can group the runs.
  { table: 'conversations', column: 'schedule_id', definition: 'TEXT' },
  { table: 'conversations', column: 'schedule_run_number', definition: 'INTEGER' },
  // Family links for chats that other chats start. Deleting a manager detaches its workers.
  {
    table: 'conversations',
    column: 'started_by_kind',
    definition: "TEXT NOT NULL DEFAULT 'user'"
  },
  {
    table: 'conversations',
    column: 'started_by_conversation_id',
    definition: 'TEXT REFERENCES conversations(id) ON DELETE SET NULL'
  },
  {
    table: 'conversations',
    column: 'report_to_conversation_id',
    definition: 'TEXT REFERENCES conversations(id) ON DELETE SET NULL'
  },
  { table: 'conversations', column: 'session_handle', definition: 'TEXT' },
  { table: 'conversations', column: 'work_in', definition: 'TEXT' },
  { table: 'conversations', column: 'archived_at', definition: 'INTEGER' },
  // The most a chat may do without asking, stricter than the user's setting. A schedule stores
  // one, its chats copy it, and the chats they start inherit it.
  { table: 'schedules', column: 'permission_ceiling', definition: 'TEXT' },
  // Whether each run starts a new chat or continues the last run's.
  { table: 'schedules', column: 'chat_mode', definition: "TEXT NOT NULL DEFAULT 'new'" },
  { table: 'conversations', column: 'permission_ceiling', definition: 'TEXT' },
  // Who made a schedule: the user, or the agent in a chat, which the Schedules dialog shows.
  { table: 'schedules', column: 'created_by_kind', definition: "TEXT NOT NULL DEFAULT 'user'" },
  {
    table: 'schedules',
    column: 'created_by_conversation_id',
    definition: 'TEXT REFERENCES conversations(id) ON DELETE SET NULL'
  },
  // The model the chat runs with. Each chat keeps its own; the setting is only where new chats start.
  { table: 'conversations', column: 'model_id', definition: 'TEXT' }
] as const

const SCHEDULE_TABLES = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    project_id TEXT,
    model_id TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekdays', 'weekly')),
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    weekday INTEGER NOT NULL,
    catch_up INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    paused_reason TEXT,
    next_run_at INTEGER,
    last_run_at INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    permission_ceiling TEXT,
    chat_mode TEXT NOT NULL DEFAULT 'new',
    created_by_kind TEXT NOT NULL DEFAULT 'user',
    created_by_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    run_number INTEGER,
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('started', 'skipped', 'failed')),
    trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
    late INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    conversation_id TEXT,
    agent_run_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule
    ON schedule_runs(schedule_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_schedules_due
    ON schedules(enabled, next_run_at);

  CREATE INDEX IF NOT EXISTS idx_schedule_runs_agent_run
    ON schedule_runs(agent_run_id);
`

const SESSION_TABLES = `
  CREATE INDEX IF NOT EXISTS idx_conversations_started_by
    ON conversations(started_by_conversation_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_session_handle
    ON conversations(started_by_conversation_id, session_handle)
    WHERE started_by_conversation_id IS NOT NULL AND session_handle IS NOT NULL;

  CREATE TABLE IF NOT EXISTS session_attachments (
    id TEXT PRIMARY KEY,
    sender_conversation_id TEXT,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    content TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (sender_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    from_conversation_id TEXT,
    to_conversation_id TEXT NOT NULL,
    intent TEXT NOT NULL
      CHECK (intent IN ('brief', 'request', 'response', 'update', 'report', 'status')),
    body TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    reply_to_message_id TEXT,
    created_at INTEGER NOT NULL,
    delivered_run_id TEXT,
    delivered_at INTEGER,
    read_at INTEGER,
    FOREIGN KEY (from_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
    FOREIGN KEY (to_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to_message_id) REFERENCES session_messages(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_session_messages_inbox
    ON session_messages(to_conversation_id, delivered_at, created_at);

  CREATE INDEX IF NOT EXISTS idx_session_messages_sender
    ON session_messages(from_conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS session_proposals (
    id TEXT PRIMARY KEY,
    proposer_conversation_id TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'started', 'dismissed', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    started_conversation_id TEXT,
    FOREIGN KEY (proposer_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (started_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_session_proposals_proposer
    ON session_proposals(proposer_conversation_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS session_project_grants (
    conversation_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (conversation_id, project_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`

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
  },
  {
    id: '20260923_001_message_notice_tone',
    description: 'persist the presentation tone of app-authored conversation notices',
    contentId: 'v1|required-message-notice-tone-column',
    apply: (db) => {
      ensureRequiredColumns(db)
    }
  },
  {
    id: '20260923_002_message_goal_origin',
    description: 'mark the message a persistent goal began from',
    contentId: 'v1|required-message-starts-goal-column',
    apply: (db) => {
      ensureRequiredColumns(db)
    }
  },
  {
    id: '20261016_001_schedules',
    description: 'store schedules, their runs, and the schedule that created each chat',
    contentId: 'v1|schedules-and-schedule-runs-tables|required-conversation-schedule-columns',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec(SCHEDULE_TABLES)
    }
  },
  {
    id: '20261016_002_worktree_base_ref',
    description: 'record the branch or commit each managed worktree started from',
    contentId: 'v1|required-managed-worktree-base-ref-column',
    apply: (db) => {
      ensureRequiredColumns(db)
    }
  },
  {
    id: '20261016_003_sessions',
    description: 'link chats that other chats start, with their messages, proposals and grants',
    contentId:
      'v1|required-conversation-session-columns|session-messages-attachments-proposals-grants',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec(SESSION_TABLES)
    }
  },
  {
    id: '20261016_004_group_chats_to_chats',
    description: 'turn each group chat into a manager chat with worker chats and drop group tables',
    contentId: 'v1|convert-groups-to-session-families|drop-collaboration-tables',
    apply: (db) => {
      ensureRequiredColumns(db)
      convertGroupChats(db)
    }
  },
  {
    id: '20261018_001_schedule_starters',
    description: 'mark chats a schedule created as schedule-started and store permission ceilings',
    contentId: 'v1|required-permission-ceiling-columns|backfill-schedule-started-by-kind',
    apply: (db) => {
      ensureRequiredColumns(db)
      db.exec("UPDATE conversations SET started_by_kind = 'schedule' WHERE schedule_id IS NOT NULL")
    }
  },
  {
    id: '20261020_001_detached_worktrees',
    description: 'let a managed worktree start detached, with no branch of its own',
    contentId: 'v1|rebuild-managed-worktrees-with-nullable-branch',
    apply: (db) => {
      ensureRequiredColumns(db)
      allowDetachedWorktrees(db)
    }
  },
  {
    id: '20261020_002_set_aside_worktrees',
    description: 'record managed worktrees set aside with a snapshot to keep the list short',
    contentId: 'v1|required-managed-worktree-set-aside-columns',
    apply: (db) => {
      ensureRequiredColumns(db)
    }
  },
  {
    id: '20261021_001_worktrees_belong_to_chats',
    description: 'attach each managed worktree to its chats and drop the project made for it',
    contentId: 'v1|required-worktree-columns|move-chats-to-source-project|drop-worktree-projects',
    apply: (db) => {
      ensureRequiredColumns(db)
      attachWorktreesToChats(db)
    }
  },
  {
    id: '20261028_001_project_folders',
    description: 'let a project keep extra folders and a reply keep a History point per folder',
    contentId: 'v1|project-folders-table|message-checkpoint-list-from-single-columns',
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_folders (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          folder_path TEXT NOT NULL,
          position INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, name),
          UNIQUE (project_id, folder_path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_folders_path ON project_folders(folder_path);
      `)
      listMessageCheckpoints(db)
    }
  }
]

/**
 * A reply kept one History point in two columns, for the one folder its project had. It now keeps
 * a list, one point per folder it changed; each existing point becomes a list of one.
 */
function listMessageCheckpoints(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as ColumnRow[]).map(({ name }) => name)
  )
  if (!columns.has('checkpoints')) db.exec('ALTER TABLE messages ADD COLUMN checkpoints TEXT')
  if (!columns.has('checkpoint_hash')) return
  if (columns.has('checkpoint_workspace_root')) {
    db.exec(`
      UPDATE messages
      SET checkpoints = json_array(
        json_object('workspaceRoot', checkpoint_workspace_root, 'hash', checkpoint_hash)
      )
      WHERE checkpoint_hash IS NOT NULL AND checkpoint_workspace_root IS NOT NULL;
    `)
    db.exec('ALTER TABLE messages DROP COLUMN checkpoint_workspace_root')
  }
  // A point saved before replies named their folder cannot be placed, so it is dropped.
  db.exec('ALTER TABLE messages DROP COLUMN checkpoint_hash')
}

/**
 * Worktrees used to be projects of their own, so a chat in one sat under "project · from main"
 * instead of its project. Each chat now keeps its project and points at its worktree; the
 * worktree projects go, and the table is rebuilt without its project link.
 */
function attachWorktreesToChats(db: Database.Database): void {
  const columns = (db.prepare('PRAGMA table_info(managed_worktrees)').all() as ColumnRow[]).map(
    ({ name }) => name
  )
  if (!columns.includes('project_id')) return
  const rows = db
    .prepare(
      `SELECT w.id, w.project_id, w.source_project_id, w.worktree_root,
              p.folder_path AS folder, s.folder_path AS source_folder, s.name AS source_name
       FROM managed_worktrees w
       LEFT JOIN projects p ON p.id = w.project_id
       LEFT JOIN projects s ON s.id = w.source_project_id`
    )
    .all() as Array<{
    id: string
    project_id: string
    source_project_id: string
    worktree_root: string
    folder: string | null
    source_folder: string | null
    source_name: string | null
  }>
  for (const row of rows) {
    db.prepare('UPDATE managed_worktrees SET folder_path = ? WHERE id = ?').run(
      row.folder ?? row.worktree_root,
      row.id
    )
    // A chat whose source project was removed stays outside any project, still in its worktree.
    db.prepare(
      `UPDATE conversations
       SET worktree_id = ?, project_id = ?,
           home_workspace_root = COALESCE(?, home_workspace_root),
           home_project_name = COALESCE(?, home_project_name),
           project_context_version = project_context_version + 1
       WHERE project_id = ?`
    ).run(
      row.id,
      row.source_folder ? row.source_project_id : null,
      row.source_folder,
      row.source_name,
      row.project_id
    )
    db.prepare('UPDATE schedules SET project_id = ? WHERE project_id = ?').run(
      row.source_folder ? row.source_project_id : null,
      row.project_id
    )
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.project_id)
  }
  db.exec(`
    CREATE TABLE managed_worktrees_for_chats (
      id TEXT PRIMARY KEY,
      source_project_id TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      worktree_root TEXT NOT NULL UNIQUE,
      folder_path TEXT,
      branch TEXT UNIQUE,
      base_ref TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      set_aside_at INTEGER,
      set_aside_head TEXT,
      set_aside_branch TEXT,
      snapshot_commit TEXT
    );
    INSERT INTO managed_worktrees_for_chats
      (id, source_project_id, repository_root, worktree_root, folder_path, branch, base_ref,
       created_at, last_used_at, set_aside_at, set_aside_head, set_aside_branch, snapshot_commit)
      SELECT id, source_project_id, repository_root, worktree_root, folder_path, branch, base_ref,
             created_at, last_used_at, set_aside_at, set_aside_head, set_aside_branch,
             snapshot_commit
      FROM managed_worktrees;
    DROP TABLE managed_worktrees;
    ALTER TABLE managed_worktrees_for_chats RENAME TO managed_worktrees;
    CREATE INDEX IF NOT EXISTS idx_managed_worktrees_age
      ON managed_worktrees(last_used_at ASC, created_at ASC);
  `)
}

/**
 * SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt with every row kept.
 * A fresh database already has the nullable column and is left alone.
 */
function allowDetachedWorktrees(db: Database.Database): void {
  const branch = (
    db.prepare('PRAGMA table_info(managed_worktrees)').all() as Array<{
      name: string
      notnull: number
    }>
  ).find(({ name }) => name === 'branch')
  if (!branch?.notnull) return
  db.exec(`
    CREATE TABLE managed_worktrees_detachable (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      source_project_id TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      worktree_root TEXT NOT NULL UNIQUE,
      branch TEXT UNIQUE,
      base_ref TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      set_aside_at INTEGER,
      set_aside_head TEXT,
      set_aside_branch TEXT,
      snapshot_commit TEXT
    );
    INSERT INTO managed_worktrees_detachable
      (id, project_id, source_project_id, repository_root, worktree_root, branch, base_ref,
       created_at, last_used_at, set_aside_at, set_aside_head, set_aside_branch, snapshot_commit)
      SELECT id, project_id, source_project_id, repository_root, worktree_root, branch, base_ref,
             created_at, last_used_at, set_aside_at, set_aside_head, set_aside_branch,
             snapshot_commit
      FROM managed_worktrees;
    DROP TABLE managed_worktrees;
    ALTER TABLE managed_worktrees_detachable RENAME TO managed_worktrees;
    CREATE INDEX IF NOT EXISTS idx_managed_worktrees_age
      ON managed_worktrees(last_used_at ASC, created_at ASC);
  `)
}

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

function assertSupportedMigrationLedger(db: Database.Database): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get()
  )
    return
  const migrations = new Map(SCHEMA_MIGRATIONS.map((migration) => [migration.id, migration]))
  for (const row of db.prepare('SELECT id, checksum FROM schema_migrations').all() as Array<{
    id: string
    checksum: string
  }>) {
    const migration = migrations.get(row.id)
    if (!migration)
      throw new Error(
        `Database contains an unsupported migration: ${row.id}. Use a compatible newer app.`
      )
    if (
      row.checksum !== migrationChecksum(migration) &&
      row.checksum !== legacyMigrationChecksum(migration)
    ) {
      throw new Error(`Database migration checksum mismatch: ${row.id}`)
    }
  }
}

export function applyDatabaseSchema(db: Database.Database): void {
  // Refuse incompatible/downgraded databases before even changing journal mode.
  assertSupportedMigrationLedger(db)
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  // Base DDL, destructive legacy cleanup, ledger upgrades and final indexes must
  // commit together. Individual migration transactions become nested savepoints.
  db.transaction(() => applyDatabaseSchemaTransaction(db)).immediate()
}

function applyDatabaseSchemaTransaction(db: Database.Database): void {
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
      schedule_id TEXT,
      schedule_run_number INTEGER,
      started_by_kind TEXT NOT NULL DEFAULT 'user',
      started_by_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      report_to_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      session_handle TEXT,
      work_in TEXT,
      archived_at INTEGER,
      permission_ceiling TEXT,
      model_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS managed_worktrees (
      id TEXT PRIMARY KEY,
      source_project_id TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      worktree_root TEXT NOT NULL UNIQUE,
      folder_path TEXT,
      branch TEXT UNIQUE,
      base_ref TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      set_aside_at INTEGER,
      set_aside_head TEXT,
      set_aside_branch TEXT,
      snapshot_commit TEXT
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
      checkpoints TEXT,
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
      reply_message_id TEXT,
      reply_messages_covered INTEGER NOT NULL DEFAULT 0,
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

    -- Phones the user approved for the phone companion; the secret is sealed by the OS when it can be.
    CREATE TABLE IF NOT EXISTS companion_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret BLOB NOT NULL,
      secret_sealed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_address TEXT
    );

    -- Bookmarks and history the user imported from another browser, for the Browser panel only.
    CREATE TABLE IF NOT EXISTS browser_library_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_library_bookmarks (
      source_id TEXT NOT NULL REFERENCES browser_library_sources(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      folder TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (source_id, position)
    );

    CREATE TABLE IF NOT EXISTS browser_library_history (
      source_id TEXT NOT NULL REFERENCES browser_library_sources(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      visit_count INTEGER NOT NULL,
      last_visit_at INTEGER,
      PRIMARY KEY (source_id, url)
    );
  `)
  db.exec(SCHEDULE_TABLES)

  applyVersionedMigrations(db)
  // Migrations only reconcile required columns when one of them runs, so a column listed without a
  // migration of its own never reached an installed database: summaries and schedule modes then
  // failed to save. Every start reconciles them instead.
  ensureRequiredColumns(db)

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
    assertSupportedMigrationLedger(db)
    const hasMigrationLedger = Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get()
    )
    const appliedIds = hasMigrationLedger
      ? new Set(
          (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map(
            (row) => row.id
          )
        )
      : new Set<string>()
    const needsMigration = SCHEMA_MIGRATIONS.some((migration) => !appliedIds.has(migration.id))
    if (existed && needsMigration) {
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
