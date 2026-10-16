import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { suggestSessionHandle, type SessionMessageIntent } from '../../shared/sessions'

/** Group chat tables, children first so each drop leaves no dangling reference. */
const GROUP_CHAT_TABLES = [
  'collaboration_deliveries',
  'collaboration_artifacts',
  'collaboration_participant_runs',
  'collaboration_events',
  'collaboration_agent_session_messages',
  'collaboration_agent_sessions',
  'collaboration_missions',
  'collaboration_participants',
  'collaboration_groups'
] as const

interface GroupRow {
  id: string
  title: string
  status: string
  created_at: number
  updated_at: number
  unread_completion_at: number | null
}

interface ParticipantRow {
  id: string
  project_id: string
  label: string
  status: string
  joined_at: number
  removed_at: number | null
  project_name: string | null
  folder_path: string | null
}

interface EventRow {
  actor_type: string
  actor_participant_id: string | null
  kind: string
  payload_json: string
  created_at: number
}

function parse(json: string): { text?: string; metadata?: Record<string, unknown> } {
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** How a group message reads as a message between chats. */
function intentFor(messageType: unknown): SessionMessageIntent {
  if (messageType === 'request' || messageType === 'response') return messageType
  return messageType === 'completion' ? 'report' : 'update'
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  )
}

/**
 * Turns every group chat into a standalone manager chat with one worker chat per project agent,
 * then removes the group chat tables. The manager keeps the group's shared timeline: people's
 * messages as its own, and each agent's posts as messages from that agent's worker chat. Each
 * worker keeps the agent's own replies. Tool traces and group missions are not carried over.
 */
export function convertGroupChats(db: Database.Database): void {
  if (tableExists(db, 'collaboration_groups')) {
    const groups = db
      .prepare('SELECT * FROM collaboration_groups ORDER BY created_at ASC, rowid ASC')
      .all() as GroupRow[]
    for (const group of groups) convertGroup(db, group)
  }
  // Runs of group agents belonged to the group's private sessions, which no longer exist.
  db.prepare("DELETE FROM agent_runs WHERE surface = 'collaboration'").run()
  for (const table of GROUP_CHAT_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
}

function convertGroup(db: Database.Database, group: GroupRow): void {
  const taken = (id: string): boolean =>
    Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id))
  const managerId = taken(group.id) ? randomUUID() : group.id
  const archivedAt = group.status === 'archived' ? group.updated_at : null
  const insertConversation = db.prepare(
    `INSERT INTO conversations
     (id, title, created_at, updated_at, project_id, title_source, sidebar_order,
      project_context_version, home_workspace_root, home_project_name, unread_completion_at,
      started_by_kind, started_by_conversation_id, report_to_conversation_id, session_handle,
      work_in, archived_at)
     VALUES (?, ?, ?, ?, ?, 'preserved', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, run_mode, timestamp)
     VALUES (?, ?, ?, ?, 'conversation', ?)`
  )
  insertConversation.run(
    managerId,
    group.title,
    group.created_at,
    group.updated_at,
    null,
    null,
    null,
    group.unread_completion_at ?? null,
    'user',
    null,
    null,
    null,
    null,
    archivedAt
  )
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, run_mode, timestamp)
     VALUES (?, ?, 'system', ?, 'conversation', ?)`
  ).run(
    randomUUID(),
    managerId,
    `Converted from the group chat “${group.title}”. Its shared messages are below, and each project agent is now a chat this one started.`,
    group.created_at
  )

  const participants = db
    .prepare(
      `SELECT participant.*, project.name AS project_name, project.folder_path
       FROM collaboration_participants participant
       LEFT JOIN projects project ON project.id = participant.project_id
       WHERE participant.group_id = ?
       ORDER BY participant.joined_at ASC, participant.rowid ASC`
    )
    .all(group.id) as ParticipantRow[]
  const workerByParticipant = new Map<string, string>()
  const handles: string[] = []
  for (const participant of participants) {
    const workerId = randomUUID()
    const handle = suggestSessionHandle(participant.label, handles)
    handles.push(handle)
    workerByParticipant.set(participant.id, workerId)
    insertConversation.run(
      workerId,
      participant.label,
      participant.joined_at,
      group.updated_at,
      participant.project_name ? participant.project_id : null,
      participant.folder_path,
      participant.project_name,
      null,
      'session',
      managerId,
      managerId,
      handle,
      'folder',
      archivedAt ??
        (participant.status === 'active' ? null : (participant.removed_at ?? group.updated_at))
    )
    if (participant.project_name)
      db.prepare(
        `INSERT INTO session_project_grants (conversation_id, project_id, granted_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
      ).run(managerId, participant.project_id, participant.joined_at)
    // The agent's own transcript: what it was told and what it said, without tool traces.
    const transcript = db
      .prepare(
        `SELECT message.role, message.content, message.created_at
         FROM collaboration_agent_session_messages message
         JOIN collaboration_agent_sessions session ON session.id = message.session_id
         WHERE session.participant_id = ? AND message.role IN ('user', 'assistant')
           AND trim(message.content) != ''
         ORDER BY message.created_at ASC, message.rowid ASC`
      )
      .all(participant.id) as Array<{ role: string; content: string; created_at: number }>
    for (const entry of transcript)
      insertMessage.run(
        randomUUID(),
        workerId,
        entry.role === 'assistant' ? 'agent' : 'user',
        entry.content,
        entry.created_at
      )
  }

  const events = db
    .prepare(
      `SELECT actor_type, actor_participant_id, kind, payload_json, created_at
       FROM collaboration_events WHERE group_id = ? ORDER BY seq ASC`
    )
    .all(group.id) as EventRow[]
  const insertSessionMessage = db.prepare(
    `INSERT INTO session_messages
     (id, from_conversation_id, to_conversation_id, intent, body, created_at, delivered_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const event of events) {
    const payload = parse(event.payload_json)
    const text = payload.text?.trim()
    if (!text) continue
    if (event.kind === 'user_message') {
      insertMessage.run(randomUUID(), managerId, 'user', text, event.created_at)
      continue
    }
    if (event.kind !== 'agent_message' && event.kind !== 'peer_message') continue
    const workerId = event.actor_participant_id
      ? workerByParticipant.get(event.actor_participant_id)
      : undefined
    if (!workerId) continue
    // Already read in the group, so nothing here wakes or flags a chat.
    insertSessionMessage.run(
      randomUUID(),
      workerId,
      managerId,
      intentFor(payload.metadata?.messageType),
      text,
      event.created_at,
      event.created_at,
      event.created_at
    )
  }
}
