import { randomUUID } from 'crypto'
import { realpathSync } from 'fs'
import { relative, resolve, sep } from 'path'
import Database from 'better-sqlite3'
import type {
  AddCollaborationParticipantInput,
  CollaborationArtifact,
  CollaborationAgentSession,
  CollaborationAgentSessionMessage,
  CollaborationEvent,
  CollaborationEventKind,
  CollaborationEventPayload,
  CollaborationGroup,
  CollaborationGroupDetail,
  CollaborationMission,
  CollaborationParticipant,
  CollaborationParticipantRun,
  CollaborationSessionMessagePresentation,
  CreateCollaborationGroupInput,
  RewriteCollaborationMessageInput,
  SendCollaborationMessageInput,
  UpdateCollaborationGroupInput,
  UpdateCollaborationParticipantInput,
  UpdateCollaborationParticipantsInput
} from '../../shared/collaboration'
import type { ProviderTarget } from '../../shared/providerRuntime'
import type { Project } from '../../shared/projects'
import { createFallbackConversationTitle } from '../../shared/conversationTitles'

interface GroupRow {
  id: string
  title: string
  description: string | null
  status: CollaborationGroup['status']
  created_at: number
  updated_at: number
  active_mission_id: string | null
  active_mission_status: CollaborationMission['status'] | null
  participant_count: number
  unread_completion_at: number | null
}

interface ParticipantRow {
  id: string
  group_id: string
  project_id: string
  project_name: string
  project_folder: string
  label: string
  provider_target_json: string
  status: CollaborationParticipant['status']
  joined_at: number
  removed_at: number | null
  last_read_seq: number
}

interface MissionRow {
  id: string
  group_id: string
  objective_event_id: string
  status: CollaborationMission['status']
  requested_participants_json: string
  round_count: number
  created_at: number
  updated_at: number
  completed_at: number | null
  error: string | null
}

interface ParticipantRunRow {
  mission_id: string
  participant_id: string
  status: CollaborationParticipantRun['status']
  iteration_count: number
  max_iterations: number
  last_ingested_seq: number
  current_activity: string | null
  started_at: number | null
  updated_at: number
  completed_at: number | null
  error: string | null
}

interface AgentSessionRow {
  id: string
  group_id: string
  participant_id: string
  project_id: string
  title: string
  active_run_status?: CollaborationParticipantRun['status'] | null
  last_event_seq: number
  unread_completion_at: number | null
  created_at: number
  updated_at: number
}

interface AgentSessionMessageRow {
  id: string
  session_id: string
  mission_id: string | null
  role: CollaborationAgentSessionMessage['role']
  kind: CollaborationAgentSessionMessage['kind']
  content: string
  tool_calls_json: string | null
  tool_call_id: string | null
  metadata_json: string
  created_at: number
}

interface EventRow {
  id: string
  group_id: string
  mission_id: string | null
  seq: number
  actor_type: CollaborationEvent['actorType']
  actor_participant_id: string | null
  kind: CollaborationEventKind
  payload_json: string
  reply_to_event_id: string | null
  created_at: number
}

interface ArtifactRow {
  id: string
  group_id: string
  mission_id: string | null
  sender_participant_id: string
  name: string
  source_path: string
  content: string
  byte_size: number
  sha256: string
  created_at: number
}

interface StoredCollaborationArtifact extends CollaborationArtifact {
  content: string
}

export interface CollaborationTimelineRewritePlan {
  boundary: CollaborationEvent
  targetParticipantIds: string[]
  participants: Array<
    CollaborationParticipant & {
      checkpointHashes: string[]
      historyUnavailable: boolean
    }
  >
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function mapGroup(row: GroupRow): CollaborationGroup {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeMissionId: row.active_mission_id,
    activeMissionStatus: row.active_mission_status,
    participantCount: row.participant_count,
    unreadCompletionAt: row.unread_completion_at,
    agentSessions: []
  }
}

function mapParticipant(row: ParticipantRow): CollaborationParticipant {
  return {
    id: row.id,
    groupId: row.group_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectFolder: row.project_folder,
    label: row.label,
    providerTarget: parseJson<ProviderTarget>(row.provider_target_json, {
      providerKind: 'openai-compatible',
      model: ''
    }),
    status: row.status,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
    lastReadSeq: row.last_read_seq
  }
}

function mapMission(row: MissionRow): CollaborationMission {
  return {
    id: row.id,
    groupId: row.group_id,
    objectiveEventId: row.objective_event_id,
    status: row.status,
    requestedParticipantIds: parseJson<string[]>(row.requested_participants_json, []),
    iterationCount: row.round_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error
  }
}

function mapParticipantRun(row: ParticipantRunRow): CollaborationParticipantRun {
  return {
    missionId: row.mission_id,
    participantId: row.participant_id,
    status: row.status,
    iterationCount: row.iteration_count,
    maxIterations: row.max_iterations,
    lastIngestedSeq: row.last_ingested_seq,
    currentActivity: row.current_activity,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error
  }
}

function mapAgentSession(row: AgentSessionRow): CollaborationAgentSession {
  return {
    id: row.id,
    groupId: row.group_id,
    participantId: row.participant_id,
    projectId: row.project_id,
    title: row.title,
    activeRunStatus: row.active_run_status ?? null,
    lastEventSeq: row.last_event_seq,
    unreadCompletionAt: row.unread_completion_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapAgentSessionMessage(row: AgentSessionMessageRow): CollaborationAgentSessionMessage {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
  return {
    id: row.id,
    sessionId: row.session_id,
    missionId: row.mission_id,
    role: row.role,
    kind: row.kind,
    presentation: sessionMessagePresentation(row.kind, metadata),
    content: row.content,
    toolCalls: parseJson(row.tool_calls_json || '[]', []),
    toolCallId: row.tool_call_id,
    metadata,
    createdAt: row.created_at
  }
}

const sessionMessagePresentations = new Set<CollaborationSessionMessagePresentation>([
  'conversation',
  'internal',
  'notice',
  'history'
])

function sessionMessagePresentation(
  kind: CollaborationAgentSessionMessage['kind'],
  metadata: Record<string, unknown>
): CollaborationSessionMessagePresentation {
  const stored = metadata.presentation
  if (
    typeof stored === 'string' &&
    sessionMessagePresentations.has(stored as CollaborationSessionMessagePresentation)
  ) {
    return stored as CollaborationSessionMessagePresentation
  }
  // Classify records written before presentation became explicit.
  if (kind === 'shared_event' || metadata.coordinationReminder === true) return 'internal'
  if (typeof metadata.checkpointHash === 'string') return 'history'
  if (kind === 'system') return 'notice'
  return 'conversation'
}

function mapEvent(row: EventRow): CollaborationEvent {
  return {
    id: row.id,
    groupId: row.group_id,
    missionId: row.mission_id,
    seq: row.seq,
    actorType: row.actor_type,
    actorParticipantId: row.actor_participant_id,
    kind: row.kind,
    payload: parseJson<CollaborationEventPayload>(row.payload_json, {}),
    replyToEventId: row.reply_to_event_id,
    createdAt: row.created_at
  }
}

function mapArtifact(row: ArtifactRow): StoredCollaborationArtifact {
  return {
    id: row.id,
    groupId: row.group_id,
    missionId: row.mission_id,
    senderParticipantId: row.sender_participant_id,
    name: row.name,
    sourcePath: row.source_path,
    content: row.content,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = canonicalPath(left)
  const b = canonicalPath(right)
  const fromAToB = relative(a, b)
  const fromBToA = relative(b, a)
  const inside = (value: string): boolean =>
    value === '' || (value !== '..' && !value.startsWith(`..${sep}`))
  return inside(fromAToB) || inside(fromBToA)
}

export class CollaborationStore {
  constructor(private readonly db: Database.Database) {}

  listGroups(): CollaborationGroup[] {
    const groups = (
      this.db
        .prepare(
          `SELECT g.*,
             (SELECT m.id FROM collaboration_missions m
              WHERE m.group_id = g.id AND m.status IN ('queued', 'running', 'paused')
              ORDER BY m.created_at DESC LIMIT 1) AS active_mission_id,
             (SELECT m.status FROM collaboration_missions m
              WHERE m.group_id = g.id AND m.status IN ('queued', 'running', 'paused')
              ORDER BY m.created_at DESC LIMIT 1) AS active_mission_status,
             (SELECT COUNT(*) FROM collaboration_participants p
              WHERE p.group_id = g.id AND p.status = 'active') AS participant_count
           FROM collaboration_groups g
           ORDER BY g.status = 'active' DESC, g.updated_at DESC`
        )
        .all() as GroupRow[]
    ).map(mapGroup)
    for (const group of groups) {
      for (const participant of this.listParticipants(group.id, true)) {
        this.ensureParticipantAgentSession(participant.id)
      }
      this.backfillAgentSessionTitles(group)
      group.agentSessions = this.listAgentSessions(group.id)
    }
    return groups
  }

  getGroup(id: string): CollaborationGroup | null {
    const row = this.db
      .prepare(
        `SELECT g.*,
           (SELECT m.id FROM collaboration_missions m
            WHERE m.group_id = g.id AND m.status IN ('queued', 'running', 'paused')
            ORDER BY m.created_at DESC LIMIT 1) AS active_mission_id,
           (SELECT m.status FROM collaboration_missions m
            WHERE m.group_id = g.id AND m.status IN ('queued', 'running', 'paused')
            ORDER BY m.created_at DESC LIMIT 1) AS active_mission_status,
           (SELECT COUNT(*) FROM collaboration_participants p
            WHERE p.group_id = g.id AND p.status = 'active') AS participant_count
         FROM collaboration_groups g WHERE g.id = ?`
      )
      .get(id) as GroupRow | undefined
    if (!row) return null
    const group = mapGroup(row)
    group.agentSessions = this.listAgentSessions(id)
    return group
  }

  listParticipants(groupId: string, includeRemoved = false): CollaborationParticipant[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, project.name AS project_name, project.folder_path AS project_folder
         FROM collaboration_participants p
         JOIN projects project ON project.id = p.project_id
         WHERE p.group_id = ? ${includeRemoved ? '' : "AND p.status = 'active'"}
         ORDER BY p.status = 'active' DESC, p.joined_at ASC`
      )
      .all(groupId) as ParticipantRow[]
    return rows.map(mapParticipant)
  }

  getParticipant(id: string): CollaborationParticipant | null {
    const row = this.db
      .prepare(
        `SELECT p.*, project.name AS project_name, project.folder_path AS project_folder
         FROM collaboration_participants p
         JOIN projects project ON project.id = p.project_id
         WHERE p.id = ?`
      )
      .get(id) as ParticipantRow | undefined
    return row ? mapParticipant(row) : null
  }

  getWorkspaceMemory(workspacePath: string): string {
    const row = this.db
      .prepare('SELECT content FROM workspace_memory WHERE workspace_path = ?')
      .get(workspacePath) as { content: string } | undefined
    return row?.content || ''
  }

  ensureParticipantAgentSession(participantId: string): CollaborationAgentSession {
    const existing = this.getParticipantSession(participantId)
    if (existing) return existing
    const participant = this.getParticipant(participantId)
    if (!participant) throw new Error('Participant not found')
    const group = this.getGroup(participant.groupId)
    if (!group) throw new Error('Group not found')
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO collaboration_agent_sessions
         (id, group_id, participant_id, project_id, title, last_event_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        participant.groupId,
        participant.id,
        participant.projectId,
        'New Conversation',
        now,
        now
      )
    return this.getAgentSession(id)!
  }

  listAgentSessions(groupId: string): CollaborationAgentSession[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, r.status AS active_run_status
           FROM collaboration_agent_sessions s
           LEFT JOIN collaboration_missions m
             ON m.id = (
               SELECT active.id FROM collaboration_missions active
               WHERE active.group_id = s.group_id
                 AND active.status IN ('queued', 'running', 'paused')
               ORDER BY active.created_at DESC LIMIT 1
             )
           LEFT JOIN collaboration_participant_runs r
             ON r.mission_id = m.id AND r.participant_id = s.participant_id
           WHERE s.group_id = ? ORDER BY s.created_at ASC`
        )
        .all(groupId) as AgentSessionRow[]
    ).map(mapAgentSession)
  }

  getAgentSession(id: string): CollaborationAgentSession | null {
    const row = this.db
      .prepare(
        `SELECT s.*, r.status AS active_run_status
         FROM collaboration_agent_sessions s
         LEFT JOIN collaboration_missions m
           ON m.id = (
             SELECT active.id FROM collaboration_missions active
             WHERE active.group_id = s.group_id
               AND active.status IN ('queued', 'running', 'paused')
             ORDER BY active.created_at DESC LIMIT 1
           )
         LEFT JOIN collaboration_participant_runs r
           ON r.mission_id = m.id AND r.participant_id = s.participant_id
         WHERE s.id = ?`
      )
      .get(id) as AgentSessionRow | undefined
    return row ? mapAgentSession(row) : null
  }

  getParticipantSession(participantId: string): CollaborationAgentSession | null {
    const row = this.db
      .prepare(
        `SELECT s.*, r.status AS active_run_status
         FROM collaboration_agent_sessions s
         LEFT JOIN collaboration_missions m
           ON m.id = (
             SELECT active.id FROM collaboration_missions active
             WHERE active.group_id = s.group_id
               AND active.status IN ('queued', 'running', 'paused')
             ORDER BY active.created_at DESC LIMIT 1
           )
         LEFT JOIN collaboration_participant_runs r
           ON r.mission_id = m.id AND r.participant_id = s.participant_id
         WHERE s.participant_id = ?`
      )
      .get(participantId) as AgentSessionRow | undefined
    return row ? mapAgentSession(row) : null
  }

  updateAgentSession(id: string, title: string): CollaborationAgentSession {
    const normalized = title.trim()
    if (!normalized) throw new Error('Conversation title is required')
    if (normalized.length > 160) throw new Error('Conversation title is too long')
    const session = this.getAgentSession(id)
    if (!session) throw new Error('Agent conversation not found')
    this.db
      .prepare('UPDATE collaboration_agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(normalized, Date.now(), id)
    this.touchGroup(session.groupId)
    return this.getAgentSession(id)!
  }

  markGroupRead(id: string): boolean {
    return this.db.transaction(() => {
      const group = this.db
        .prepare('UPDATE collaboration_groups SET unread_completion_at = NULL WHERE id = ?')
        .run(id)
      this.db
        .prepare(
          'UPDATE collaboration_agent_sessions SET unread_completion_at = NULL WHERE group_id = ?'
        )
        .run(id)
      return group.changes === 1
    })()
  }

  markAgentSessionRead(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE collaboration_agent_sessions SET unread_completion_at = NULL WHERE id = ?')
        .run(id).changes === 1
    )
  }

  private backfillAgentSessionTitles(group: CollaborationGroup): void {
    const firstUserEvent = this.db
      .prepare(
        `SELECT payload_json FROM collaboration_events
         WHERE group_id = ? AND kind = 'user_message'
         ORDER BY seq ASC LIMIT 1`
      )
      .get(group.id) as { payload_json: string } | undefined
    if (!firstUserEvent) return
    const payload = parseJson<CollaborationEventPayload>(firstUserEvent.payload_json, {})
    if (!payload.text?.trim()) return
    const title = createFallbackConversationTitle(payload.text)
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE collaboration_agent_sessions AS session
         SET title = ?, updated_at = MAX(updated_at, ?)
         WHERE group_id = ? AND (
           title = 'New Conversation' OR
           title = ? || ' · ' || (
             SELECT label FROM collaboration_participants
             WHERE collaboration_participants.id = session.participant_id
           )
         )`
      )
      .run(title, now, group.id, group.title)
  }

  listAgentSessionMessages(
    sessionId: string,
    afterCreatedAt = 0,
    limit = 1_000
  ): CollaborationAgentSessionMessage[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)))
    return (
      this.db
        .prepare(
          `SELECT * FROM collaboration_agent_session_messages
           WHERE session_id = ? AND created_at > ?
           ORDER BY created_at ASC, rowid ASC LIMIT ?`
        )
        .all(sessionId, afterCreatedAt, safeLimit) as AgentSessionMessageRow[]
    ).map(mapAgentSessionMessage)
  }

  listRecentAgentSessionMessages(
    sessionId: string,
    limit = 240
  ): CollaborationAgentSessionMessage[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM collaboration_agent_session_messages
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(sessionId, safeLimit) as AgentSessionMessageRow[]
    return rows.reverse().map(mapAgentSessionMessage)
  }

  appendAgentSessionMessage(input: {
    sessionId: string
    missionId?: string | null
    role: CollaborationAgentSessionMessage['role']
    kind: CollaborationAgentSessionMessage['kind']
    presentation?: CollaborationSessionMessagePresentation
    content?: string | null
    toolCalls?: CollaborationAgentSessionMessage['toolCalls']
    toolCallId?: string | null
    metadata?: Record<string, unknown>
  }): CollaborationAgentSessionMessage {
    const session = this.getAgentSession(input.sessionId)
    if (!session) throw new Error('Collaboration agent session not found')
    const id = randomUUID()
    const createdAt = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO collaboration_agent_session_messages
           (id, session_id, mission_id, role, kind, content, tool_calls_json,
            tool_call_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.sessionId,
          input.missionId ?? null,
          input.role,
          input.kind,
          input.content || '',
          input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
          input.toolCallId ?? null,
          JSON.stringify({
            ...(input.metadata || {}),
            presentation:
              input.presentation || sessionMessagePresentation(input.kind, input.metadata || {})
          }),
          createdAt
        )
      this.db
        .prepare('UPDATE collaboration_agent_sessions SET updated_at = ? WHERE id = ?')
        .run(createdAt, input.sessionId)
      this.touchGroup(session.groupId)
    })()
    return this.listAgentSessionMessages(input.sessionId, createdAt - 1, 10).find(
      (message) => message.id === id
    )!
  }

  updateAgentSessionCursor(sessionId: string, lastEventSeq: number): void {
    this.db
      .prepare(
        `UPDATE collaboration_agent_sessions
         SET last_event_seq = MAX(last_event_seq, ?), updated_at = ? WHERE id = ?`
      )
      .run(lastEventSeq, Date.now(), sessionId)
  }

  listSharedChannelEvents(groupId: string, afterSeq = 0, limit = 500): CollaborationEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)))
    return (
      this.db
        .prepare(
          `SELECT * FROM collaboration_events
           WHERE group_id = ? AND seq > ?
             AND kind IN ('user_message', 'agent_message', 'peer_message')
           ORDER BY seq ASC LIMIT ?`
        )
        .all(groupId, afterSeq, safeLimit) as EventRow[]
    ).map(mapEvent)
  }

  listRecentSharedChannelEvents(groupId: string, limit = 500): CollaborationEvent[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM collaboration_events
         WHERE group_id = ?
           AND kind IN ('user_message', 'agent_message', 'peer_message')
         ORDER BY seq DESC LIMIT ?`
      )
      .all(groupId, safeLimit) as EventRow[]
    return rows.reverse().map(mapEvent)
  }

  listEvents(groupId: string, afterSeq = 0, limit = 500): CollaborationEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM collaboration_events
         WHERE group_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`
      )
      .all(groupId, afterSeq, safeLimit) as EventRow[]
    return rows.map(mapEvent)
  }

  listRecentEvents(groupId: string, limit = 500): CollaborationEvent[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)))
    const rows = this.db
      .prepare(
        `SELECT * FROM collaboration_events
         WHERE group_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(groupId, safeLimit) as EventRow[]
    return rows.reverse().map(mapEvent)
  }

  listMissionEvents(missionId: string, limit = 20_000): CollaborationEvent[] {
    const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(limit)))
    return (
      this.db
        .prepare(
          `SELECT * FROM collaboration_events
           WHERE mission_id = ? ORDER BY seq ASC LIMIT ?`
        )
        .all(missionId, safeLimit) as EventRow[]
    ).map(mapEvent)
  }

  createArtifact(input: {
    groupId: string
    missionId: string
    senderParticipantId: string
    name: string
    sourcePath: string
    content: string
    byteSize: number
    sha256: string
  }): CollaborationArtifact {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO collaboration_artifacts
         (id, group_id, mission_id, sender_participant_id, name, source_path,
          content, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.groupId,
        input.missionId,
        input.senderParticipantId,
        input.name,
        input.sourcePath,
        input.content,
        input.byteSize,
        input.sha256,
        createdAt
      )
    const { content: _content, ...artifact } = this.getArtifact(id)!
    return artifact
  }

  listArtifacts(groupId: string): CollaborationArtifact[] {
    return (
      this.db
        .prepare(
          `SELECT id, group_id, mission_id, sender_participant_id, name, source_path,
                  '' AS content, byte_size, sha256, created_at
           FROM collaboration_artifacts WHERE group_id = ?
           ORDER BY created_at DESC LIMIT 500`
        )
        .all(groupId) as ArtifactRow[]
    ).map(({ content: _content, ...row }) => {
      const artifact = mapArtifact({ ...row, content: '' })
      const { content: _storedContent, ...metadata } = artifact
      return metadata
    })
  }

  getArtifact(id: string): StoredCollaborationArtifact | null {
    const row = this.db.prepare('SELECT * FROM collaboration_artifacts WHERE id = ?').get(id) as
      | ArtifactRow
      | undefined
    return row ? mapArtifact(row) : null
  }

  getMission(id: string): CollaborationMission | null {
    const row = this.db.prepare('SELECT * FROM collaboration_missions WHERE id = ?').get(id) as
      | MissionRow
      | undefined
    return row ? mapMission(row) : null
  }

  getActiveMission(groupId: string): CollaborationMission | null {
    const row = this.db
      .prepare(
        `SELECT * FROM collaboration_missions
         WHERE group_id = ? AND status IN ('queued', 'running', 'paused')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(groupId) as MissionRow | undefined
    return row ? mapMission(row) : null
  }

  listParticipantRuns(missionId: string): CollaborationParticipantRun[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM collaboration_participant_runs
           WHERE mission_id = ? ORDER BY updated_at ASC, participant_id ASC`
        )
        .all(missionId) as ParticipantRunRow[]
    ).map(mapParticipantRun)
  }

  getParticipantRun(missionId: string, participantId: string): CollaborationParticipantRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM collaboration_participant_runs
         WHERE mission_id = ? AND participant_id = ?`
      )
      .get(missionId, participantId) as ParticipantRunRow | undefined
    return row ? mapParticipantRun(row) : null
  }

  getDetail(id: string): CollaborationGroupDetail | null {
    const group = this.getGroup(id)
    if (!group) return null
    const participants = this.listParticipants(id, true)
    for (const participant of participants) this.ensureParticipantAgentSession(participant.id)
    this.backfillAgentSessionTitles(group)
    const agentSessions = this.listAgentSessions(id)
    group.agentSessions = agentSessions
    const recentEvents = this.listRecentEvents(id)
    const publicEvents = this.listRecentSharedChannelEvents(id)
    const events = [
      ...new Map([...recentEvents, ...publicEvents].map((event) => [event.id, event])).values()
    ].sort((left, right) => left.seq - right.seq)
    return {
      group,
      participants,
      agentSessions,
      activeMission: this.getActiveMission(id),
      participantRuns: group.activeMissionId ? this.listParticipantRuns(group.activeMissionId) : [],
      events
    }
  }

  createGroup(input: CreateCollaborationGroupInput): CollaborationGroupDetail {
    const title = input.title.trim()
    if (!title) throw new Error('Group name is required')
    if (input.participants.length !== 2) {
      throw new Error('A group chat currently requires exactly two project agents')
    }
    const projectIds = input.participants.map(({ projectId }) => projectId)
    if (new Set(projectIds).size !== projectIds.length) {
      throw new Error('Each participant must belong to a different project')
    }
    const placeholders = projectIds.map(() => '?').join(', ')
    const projects = this.db
      .prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`)
      .all(...projectIds) as Project[]
    if (projects.length !== projectIds.length)
      throw new Error('One or more projects no longer exist')
    if (pathsOverlap(projects[0].folder_path, projects[1].folder_path)) {
      throw new Error('Collaborating projects cannot contain one another or share the same folder')
    }
    for (const participant of input.participants) {
      if (!participant.providerTarget.model.trim()) throw new Error('Every agent needs a model')
    }

    const groupId = randomUUID()
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO collaboration_groups
           (id, title, description, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`
        )
        .run(groupId, title, input.description?.trim() || null, now, now)
      const insertParticipant = this.db.prepare(
        `INSERT INTO collaboration_participants
         (id, group_id, project_id, label, provider_target_json, status, joined_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      for (const participant of input.participants) {
        const project = projects.find(({ id }) => id === participant.projectId)!
        const participantId = randomUUID()
        insertParticipant.run(
          participantId,
          groupId,
          project.id,
          participant.label?.trim() || `${project.name} agent`,
          JSON.stringify(participant.providerTarget),
          now
        )
        this.ensureParticipantAgentSession(participantId)
      }
      this.appendEventInternal({
        groupId,
        missionId: null,
        actorType: 'system',
        actorParticipantId: null,
        kind: 'system',
        payload: { text: 'Group created. Start a mission by sending a message.' }
      })
    })()
    return this.getDetail(groupId)!
  }

  updateGroup(id: string, input: UpdateCollaborationGroupInput): CollaborationGroup {
    const current = this.getGroup(id)
    if (!current) throw new Error('Group not found')
    const title = input.title === undefined ? current.title : input.title.trim()
    if (!title) throw new Error('Group name is required')
    const description =
      input.description === undefined ? current.description : input.description.trim() || null
    const status = input.status ?? current.status
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE collaboration_groups SET title = ?, description = ?, status = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(title, description, status, now, id)
    })()
    return this.getGroup(id)!
  }

  deleteGroup(id: string): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE collaboration_groups SET status = 'archived', updated_at = ? WHERE id = ?`)
        .run(now, id)
      this.db
        .prepare(
          `UPDATE collaboration_participants
           SET status = 'removed', removed_at = COALESCE(removed_at, ?)
           WHERE group_id = ? AND status = 'active'`
        )
        .run(now, id)
      this.db
        .prepare(
          `UPDATE collaboration_missions
           SET status = 'stopped', updated_at = ?, completed_at = COALESCE(completed_at, ?)
           WHERE group_id = ? AND status IN ('queued', 'running', 'paused')`
        )
        .run(now, now, id)
    })()
  }

  addParticipant(input: AddCollaborationParticipantInput): CollaborationParticipant {
    const group = this.getGroup(input.groupId)
    if (!group || group.status !== 'active') throw new Error('Group is unavailable')
    if (this.getActiveMission(input.groupId)?.status === 'running') {
      throw new Error('Pause or finish the current mission before changing participants')
    }
    const active = this.listParticipants(input.groupId)
    if (active.length >= 2) throw new Error('Group chats currently support two project agents')
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as
      | Project
      | undefined
    if (!project) throw new Error('Project not found')
    if (
      active.some((participant) => pathsOverlap(participant.projectFolder, project.folder_path))
    ) {
      throw new Error('Collaborating projects cannot contain one another or share the same folder')
    }
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO collaboration_participants
         (id, group_id, project_id, label, provider_target_json, status, joined_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(
        id,
        input.groupId,
        input.projectId,
        input.label?.trim() || `${project.name} agent`,
        JSON.stringify(input.providerTarget),
        now
      )
    this.touchGroup(input.groupId)
    this.ensureParticipantAgentSession(id)
    return this.getParticipant(id)!
  }

  updateParticipant(
    participantId: string,
    input: UpdateCollaborationParticipantInput
  ): CollaborationParticipant {
    const participant = this.getParticipant(participantId)
    if (!participant) throw new Error('Participant not found')
    return this.updateParticipants({
      groupId: participant.groupId,
      participantIds: [participantId],
      providerTarget: input.providerTarget
    })[0]
  }

  updateParticipants(input: UpdateCollaborationParticipantsInput): CollaborationParticipant[] {
    const ids = [...new Set(input.participantIds)]
    if (!ids.length) throw new Error('At least one participant is required')
    if (!input.providerTarget.model.trim()) throw new Error('A model is required')
    return this.db.transaction(() => {
      const participants = ids.map((id) => this.getParticipant(id))
      if (
        participants.some(
          (participant) =>
            !participant || participant.status !== 'active' || participant.groupId !== input.groupId
        )
      ) {
        throw new Error('Participant not found')
      }
      const activeMission = this.getActiveMission(input.groupId)
      if (
        activeMission &&
        participants.some((participant) => {
          const run = this.getParticipantRun(activeMission.id, participant!.id)
          return run && ['queued', 'working'].includes(run.status)
        })
      ) {
        throw new Error('Pause the addressed agents before changing their model')
      }
      const statement = this.db.prepare(
        'UPDATE collaboration_participants SET provider_target_json = ? WHERE id = ?'
      )
      for (const participant of participants) {
        statement.run(JSON.stringify(input.providerTarget), participant!.id)
      }
      this.touchGroup(input.groupId)
      return ids.map((id) => this.getParticipant(id)!)
    })()
  }

  removeParticipant(groupId: string, participantId: string): void {
    if (this.getActiveMission(groupId)?.status === 'running') {
      throw new Error('Pause or finish the current mission before changing participants')
    }
    const participant = this.getParticipant(participantId)
    if (!participant || participant.groupId !== groupId) throw new Error('Participant not found')
    this.db
      .prepare(
        `UPDATE collaboration_participants
         SET status = 'removed', removed_at = ? WHERE id = ? AND group_id = ?`
      )
      .run(Date.now(), participantId, groupId)
    this.touchGroup(groupId)
  }

  sendUserMessage(input: SendCollaborationMessageInput): {
    event: CollaborationEvent
    mission: CollaborationMission
  } {
    const text = input.text.trim()
    if (!text) throw new Error('Message cannot be empty')
    const group = this.getGroup(input.groupId)
    if (!group || group.status !== 'active') throw new Error('Group is unavailable')
    const participants = this.listParticipants(input.groupId)
    if (participants.length !== 2) throw new Error('A mission requires two active project agents')
    const requested = input.targetParticipantIds?.length
      ? [...new Set(input.targetParticipantIds)]
      : participants.map(({ id }) => id)
    if (requested.some((id) => !participants.some((participant) => participant.id === id))) {
      throw new Error('Message targets must be active members of this group')
    }

    let mission = this.getActiveMission(input.groupId)
    let event!: CollaborationEvent
    this.db.transaction(() => {
      if (!mission || !['queued', 'running', 'paused'].includes(mission.status)) {
        const missionId = randomUUID()
        const eventId = randomUUID()
        const now = Date.now()
        this.db
          .prepare(
            `INSERT INTO collaboration_missions
             (id, group_id, objective_event_id, status, requested_participants_json,
              round_count, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, 0, ?, ?)`
          )
          .run(missionId, input.groupId, eventId, JSON.stringify(requested), now, now)
        const insertRun = this.db.prepare(
          `INSERT INTO collaboration_participant_runs
           (mission_id, participant_id, status, iteration_count, max_iterations,
            last_ingested_seq, updated_at)
           VALUES (?, ?, 'queued', 0, 1000, 0, ?)`
        )
        for (const participantId of requested) insertRun.run(missionId, participantId, now)
        event = this.appendEventInternal({
          id: eventId,
          groupId: input.groupId,
          missionId,
          actorType: 'user',
          actorParticipantId: null,
          kind: 'user_message',
          payload: { text, targetParticipantIds: requested }
        })
        mission = this.getMission(missionId)
      } else {
        event = this.appendEventInternal({
          groupId: input.groupId,
          missionId: mission.id,
          actorType: 'user',
          actorParticipantId: null,
          kind: 'user_message',
          payload: { text, targetParticipantIds: requested }
        })
        const ensureRun = this.db.prepare(
          `INSERT INTO collaboration_participant_runs
           (mission_id, participant_id, status, iteration_count, max_iterations,
            last_ingested_seq, updated_at)
           VALUES (?, ?, 'queued', 0, 1000, 0, ?)
           ON CONFLICT(mission_id, participant_id) DO UPDATE SET
             status = CASE
               WHEN collaboration_participant_runs.status IN ('waiting', 'completed', 'stopped') THEN 'queued'
               ELSE collaboration_participant_runs.status
             END,
             completed_at = NULL,
             updated_at = excluded.updated_at`
        )
        for (const participantId of requested) ensureRun.run(mission.id, participantId, Date.now())
      }
      const delivery = this.db.prepare(
        `INSERT OR IGNORE INTO collaboration_deliveries (event_id, participant_id, state)
         VALUES (?, ?, 'pending')`
      )
      for (const participantId of requested) delivery.run(event.id, participantId)
      this.touchGroup(input.groupId)
    })()
    return { event, mission: mission! }
  }

  prepareTimelineRewrite(
    input: RewriteCollaborationMessageInput
  ): CollaborationTimelineRewritePlan {
    const text = input.text.trim()
    if (!text) throw new Error('Message cannot be empty')
    const group = this.getGroup(input.groupId)
    if (!group || group.status !== 'active') throw new Error('Group is unavailable')
    const boundaryRow = this.db
      .prepare(
        `SELECT * FROM collaboration_events
         WHERE id = ? AND group_id = ? AND actor_type = 'user' AND kind = 'user_message'`
      )
      .get(input.eventId, input.groupId) as EventRow | undefined
    if (!boundaryRow) throw new Error('Only a human group message can restart the timeline')
    const boundary = mapEvent(boundaryRow)
    const participants = this.listParticipants(input.groupId)
    if (participants.length !== 2) throw new Error('A mission requires two active project agents')
    const targetParticipantIds = boundary.payload.targetParticipantIds?.length
      ? [...new Set(boundary.payload.targetParticipantIds)]
      : participants.map(({ id }) => id)
    if (
      targetParticipantIds.some((id) => !participants.some((participant) => participant.id === id))
    ) {
      throw new Error('The original message targets are no longer members of this group')
    }

    const sessionRows = this.db
      .prepare(
        `SELECT s.participant_id, m.metadata_json, m.created_at
         FROM collaboration_agent_session_messages m
         JOIN collaboration_agent_sessions s ON s.id = m.session_id
         WHERE s.group_id = ? AND (
           m.metadata_json LIKE '%checkpointHash%' OR
           m.metadata_json LIKE '%historyCaptureFailed%'
         )`
      )
      .all(input.groupId) as Array<{
      participant_id: string
      metadata_json: string
      created_at: number
    }>
    const references = new Map<string, Map<string, boolean>>()
    const unavailable = new Set<string>()
    for (const row of sessionRows) {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
      const coveredThrough = Number(metadata.coveredThroughEventSeq)
      const affected = Number.isFinite(coveredThrough)
        ? coveredThrough >= boundary.seq
        : row.created_at >= boundary.createdAt
      if (metadata.historyCaptureFailed === true && affected) {
        unavailable.add(row.participant_id)
      }
      const hash = typeof metadata.checkpointHash === 'string' ? metadata.checkpointHash : ''
      if (!hash) continue
      const byHash = references.get(row.participant_id) ?? new Map<string, boolean>()
      byHash.set(hash, affected)
      references.set(row.participant_id, byHash)
    }

    const eventRows = this.db
      .prepare(
        `SELECT * FROM collaboration_events
         WHERE group_id = ? AND seq >= ? AND actor_participant_id IS NOT NULL
         ORDER BY seq ASC`
      )
      .all(input.groupId, boundary.seq) as EventRow[]
    for (const event of eventRows.map(mapEvent)) {
      const hash = event.payload.metadata?.checkpointHash
      if (typeof hash !== 'string' || !event.actorParticipantId) continue
      const byHash = references.get(event.actorParticipantId) ?? new Map<string, boolean>()
      if (!byHash.has(hash)) byHash.set(hash, true)
      references.set(event.actorParticipantId, byHash)
    }

    return {
      boundary,
      targetParticipantIds,
      participants: participants.map((participant) => ({
        ...participant,
        checkpointHashes: [...(references.get(participant.id) ?? [])]
          .filter(([, affected]) => affected)
          .map(([hash]) => hash),
        historyUnavailable: unavailable.has(participant.id)
      }))
    }
  }

  replaceTimelineFromUserMessage(input: RewriteCollaborationMessageInput): {
    event: CollaborationEvent
    mission: CollaborationMission
  } {
    const plan = this.prepareTimelineRewrite(input)
    let result!: { event: CollaborationEvent; mission: CollaborationMission }
    this.db.transaction(() => {
      const missionRows = this.db
        .prepare(
          `SELECT DISTINCT mission_id AS id FROM collaboration_events
           WHERE group_id = ? AND seq >= ? AND mission_id IS NOT NULL
           UNION
           SELECT id FROM collaboration_missions
           WHERE group_id = ? AND created_at >= ?`
        )
        .all(input.groupId, plan.boundary.seq, input.groupId, plan.boundary.createdAt) as Array<{
        id: string
      }>
      if (
        plan.boundary.missionId &&
        !missionRows.some(({ id }) => id === plan.boundary.missionId)
      ) {
        missionRows.push({ id: plan.boundary.missionId })
      }
      const missionIds = missionRows.map(({ id }) => id)
      const sessionIds = this.listAgentSessions(input.groupId).map(({ id }) => id)
      const runIds = new Set<string>()
      if (sessionIds.length) {
        const placeholders = sessionIds.map(() => '?').join(', ')
        const rows = this.db
          .prepare(
            `SELECT metadata_json FROM collaboration_agent_session_messages
             WHERE session_id IN (${placeholders}) AND created_at >= ?`
          )
          .all(...sessionIds, plan.boundary.createdAt) as Array<{ metadata_json: string }>
        for (const row of rows) {
          const runId = parseJson<Record<string, unknown>>(row.metadata_json, {}).agentRunId
          if (typeof runId === 'string' && runId) runIds.add(runId)
        }
        this.db
          .prepare(
            `DELETE FROM collaboration_agent_session_messages
             WHERE session_id IN (${placeholders}) AND created_at >= ?`
          )
          .run(...sessionIds, plan.boundary.createdAt)
      }
      this.db
        .prepare('DELETE FROM collaboration_artifacts WHERE group_id = ? AND created_at >= ?')
        .run(input.groupId, plan.boundary.createdAt)
      this.db
        .prepare('DELETE FROM collaboration_events WHERE group_id = ? AND seq >= ?')
        .run(input.groupId, plan.boundary.seq)
      if (missionIds.length) {
        const placeholders = missionIds.map(() => '?').join(', ')
        this.db
          .prepare(`DELETE FROM collaboration_missions WHERE id IN (${placeholders})`)
          .run(...missionIds)
      }
      if (runIds.size) {
        const placeholders = [...runIds].map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM agent_runs WHERE id IN (${placeholders})`).run(...runIds)
      }
      this.db
        .prepare(
          `UPDATE collaboration_agent_sessions
           SET last_event_seq = MIN(last_event_seq, ?), updated_at = ? WHERE group_id = ?`
        )
        .run(Math.max(0, plan.boundary.seq - 1), Date.now(), input.groupId)
      result = this.sendUserMessage({
        groupId: input.groupId,
        text: input.text,
        targetParticipantIds: plan.targetParticipantIds
      })
      this.touchGroup(input.groupId)
    })()
    return result
  }

  appendAgentEvent(input: {
    groupId: string
    missionId: string
    participantId: string
    kind: CollaborationEventKind
    payload: CollaborationEventPayload
    deliverToParticipantIds?: string[]
    replyToEventId?: string
  }): CollaborationEvent {
    const event = this.db.transaction(() => {
      const created = this.appendEventInternal({
        groupId: input.groupId,
        missionId: input.missionId,
        actorType: 'agent',
        actorParticipantId: input.participantId,
        kind: input.kind,
        payload: input.payload,
        replyToEventId: input.replyToEventId
      })
      const delivery = this.db.prepare(
        `INSERT OR IGNORE INTO collaboration_deliveries (event_id, participant_id, state)
         VALUES (?, ?, 'pending')`
      )
      for (const participantId of input.deliverToParticipantIds || []) {
        if (participantId !== input.participantId) delivery.run(created.id, participantId)
      }
      this.touchGroup(input.groupId)
      return created
    })()
    return event
  }

  appendSystemEvent(input: {
    groupId: string
    missionId: string | null
    kind: CollaborationEventKind
    payload: CollaborationEventPayload
  }): CollaborationEvent {
    const event = this.appendEventInternal({
      groupId: input.groupId,
      missionId: input.missionId,
      actorType: 'system',
      actorParticipantId: null,
      kind: input.kind,
      payload: input.payload
    })
    this.touchGroup(input.groupId)
    return event
  }

  listPendingEvents(participantId: string): CollaborationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM collaboration_deliveries d
         JOIN collaboration_events e ON e.id = d.event_id
         WHERE d.participant_id = ? AND d.state = 'pending'
         ORDER BY e.seq ASC`
      )
      .all(participantId) as EventRow[]
    return rows.map(mapEvent)
  }

  consumeDeliveries(participantId: string, eventIds: string[]): void {
    if (!eventIds.length) return
    const now = Date.now()
    const update = this.db.prepare(
      `UPDATE collaboration_deliveries
       SET state = 'consumed', delivered_at = COALESCE(delivered_at, ?), consumed_at = ?
       WHERE participant_id = ? AND event_id = ?`
    )
    this.db.transaction(() => {
      for (const eventId of eventIds) update.run(now, now, participantId, eventId)
      const maxSeq = this.db
        .prepare(
          `SELECT MAX(e.seq) AS seq FROM collaboration_events e WHERE e.id IN (${eventIds
            .map(() => '?')
            .join(', ')})`
        )
        .get(...eventIds) as { seq: number | null }
      if (maxSeq.seq != null) {
        this.db
          .prepare(
            `UPDATE collaboration_participants
             SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`
          )
          .run(maxSeq.seq, participantId)
      }
      const missionSeqs = this.db
        .prepare(
          `SELECT mission_id, MAX(seq) AS seq FROM collaboration_events
           WHERE id IN (${eventIds.map(() => '?').join(', ')}) AND mission_id IS NOT NULL
           GROUP BY mission_id`
        )
        .all(...eventIds) as Array<{ mission_id: string; seq: number }>
      const updateRunCursor = this.db.prepare(
        `UPDATE collaboration_participant_runs
         SET last_ingested_seq = MAX(last_ingested_seq, ?), updated_at = ?
         WHERE mission_id = ? AND participant_id = ?`
      )
      for (const item of missionSeqs) {
        updateRunCursor.run(item.seq, now, item.mission_id, participantId)
      }
    })()
  }

  ensureParticipantRun(
    missionId: string,
    participantId: string,
    maxIterations: number
  ): CollaborationParticipantRun {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO collaboration_participant_runs
         (mission_id, participant_id, status, iteration_count, max_iterations,
          last_ingested_seq, updated_at)
         VALUES (?, ?, 'queued', 0, ?, 0, ?)
         ON CONFLICT(mission_id, participant_id) DO UPDATE SET
           max_iterations = MAX(max_iterations, excluded.max_iterations),
           status = CASE
             WHEN status IN ('waiting', 'completed', 'stopped') THEN 'queued'
             ELSE status
           END,
           completed_at = NULL,
           updated_at = excluded.updated_at`
      )
      .run(missionId, participantId, maxIterations, now)
    return this.getParticipantRun(missionId, participantId)!
  }

  updateParticipantRun(
    missionId: string,
    participantId: string,
    input: {
      status?: CollaborationParticipantRun['status']
      currentActivity?: string | null
      error?: string | null
    }
  ): CollaborationParticipantRun {
    const current = this.getParticipantRun(missionId, participantId)
    if (!current) throw new Error('Participant run not found')
    const status = input.status ?? current.status
    const now = Date.now()
    const completedAt = ['completed', 'stopped', 'failed'].includes(status)
      ? current.completedAt || now
      : null
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE collaboration_participant_runs
           SET status = ?, current_activity = ?, error = ?, updated_at = ?,
               started_at = CASE WHEN ? = 'working' THEN COALESCE(started_at, ?) ELSE started_at END,
               completed_at = ?
           WHERE mission_id = ? AND participant_id = ?`
        )
        .run(
          status,
          input.currentActivity === undefined ? current.currentActivity : input.currentActivity,
          input.error === undefined ? current.error : input.error,
          now,
          status,
          now,
          completedAt,
          missionId,
          participantId
        )
      if (status === 'completed' && current.status !== 'completed') {
        this.db
          .prepare(
            `UPDATE collaboration_agent_sessions
             SET unread_completion_at = ? WHERE participant_id = ?`
          )
          .run(now, participantId)
      }
    })()
    return this.getParticipantRun(missionId, participantId)!
  }

  claimParticipantIteration(
    missionId: string,
    participantId: string
  ): { run: CollaborationParticipantRun; claimed: boolean } {
    const claimed = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE collaboration_participant_runs
           SET iteration_count = iteration_count + 1,
               status = 'working',
               current_activity = 'Thinking',
               started_at = COALESCE(started_at, ?),
               updated_at = ?,
               error = NULL
           WHERE mission_id = ? AND participant_id = ?
             AND iteration_count < max_iterations
             AND EXISTS (
               SELECT 1 FROM collaboration_missions
               WHERE id = ? AND status = 'running'
             )`
        )
        .run(Date.now(), Date.now(), missionId, participantId, missionId)
      if (result.changes === 1) {
        this.db
          .prepare(
            `UPDATE collaboration_missions
             SET round_count = round_count + 1, updated_at = ? WHERE id = ?`
          )
          .run(Date.now(), missionId)
      }
      return result.changes === 1
    })()
    const run = this.getParticipantRun(missionId, participantId)
    if (!run) throw new Error('Participant run not found')
    return { run, claimed }
  }

  extendParticipantRuns(missionId: string, configuredIterations: number): void {
    const configured = Math.max(1, Math.trunc(configuredIterations))
    this.db
      .prepare(
        `UPDATE collaboration_participant_runs
           SET max_iterations = CASE
               WHEN max_iterations < ? THEN ?
               WHEN iteration_count >= max_iterations THEN max_iterations + ?
               ELSE max_iterations
             END,
             status = 'queued', current_activity = NULL, error = NULL,
             completed_at = NULL, updated_at = ?
         WHERE mission_id = ? AND status IN ('paused', 'failed')`
      )
      .run(configured, configured, configured, Date.now(), missionId)
  }

  updateMission(
    id: string,
    input: {
      status?: CollaborationMission['status']
      iterationCount?: number
      error?: string | null
    }
  ): CollaborationMission {
    const current = this.getMission(id)
    if (!current) throw new Error('Mission not found')
    const status = input.status ?? current.status
    const completedAt = ['completed', 'stopped', 'failed'].includes(status)
      ? current.completedAt || Date.now()
      : null
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE collaboration_missions
           SET status = ?, round_count = ?, error = ?, updated_at = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(
          status,
          input.iterationCount ?? current.iterationCount,
          input.error === undefined ? current.error : input.error,
          now,
          completedAt,
          id
        )
      if (status === 'paused') {
        this.db
          .prepare(
            `UPDATE collaboration_participant_runs
             SET status = 'paused', current_activity = NULL, updated_at = ?
             WHERE mission_id = ? AND status NOT IN ('completed', 'stopped', 'failed')`
          )
          .run(now, id)
      } else if (status === 'completed' || status === 'stopped' || status === 'failed') {
        this.db
          .prepare(
            `UPDATE collaboration_participant_runs
             SET status = ?, current_activity = NULL, updated_at = ?,
                 completed_at = COALESCE(completed_at, ?),
                 error = CASE WHEN ? = 'failed' THEN COALESCE(error, ?) ELSE error END
             WHERE mission_id = ? AND status NOT IN ('completed', 'stopped')`
          )
          .run(status, now, now, status, input.error ?? null, id)
      }
      if (status === 'completed' && current.status !== 'completed') {
        this.db
          .prepare('UPDATE collaboration_groups SET unread_completion_at = ? WHERE id = ?')
          .run(now, current.groupId)
        this.db
          .prepare(
            `UPDATE collaboration_agent_sessions
             SET unread_completion_at = ?
             WHERE participant_id IN (
               SELECT participant_id FROM collaboration_participant_runs
               WHERE mission_id = ? AND status = 'completed'
             )`
          )
          .run(now, id)
      }
    })()
    this.touchGroup(current.groupId)
    return this.getMission(id)!
  }

  recoverInterruptedMissions(): number {
    const now = Date.now()
    return this.db.transaction(() => {
      const interrupted = this.db
        .prepare(`SELECT id FROM collaboration_missions WHERE status IN ('queued', 'running')`)
        .all() as Array<{ id: string }>
      const result = this.db
        .prepare(
          `UPDATE collaboration_missions
           SET status = 'paused', updated_at = ?, error = 'SideKick restarted during this mission'
           WHERE status IN ('queued', 'running')`
        )
        .run(now)
      const pauseRuns = this.db.prepare(
        `UPDATE collaboration_participant_runs
         SET status = 'paused', current_activity = NULL, updated_at = ?,
             error = 'SideKick restarted while this agent was working'
         WHERE mission_id = ? AND status IN ('queued', 'working', 'waiting')`
      )
      for (const { id } of interrupted) pauseRuns.run(now, id)
      return result.changes
    })()
  }

  private appendEventInternal(input: {
    id?: string
    groupId: string
    missionId: string | null
    actorType: CollaborationEvent['actorType']
    actorParticipantId: string | null
    kind: CollaborationEventKind
    payload: CollaborationEventPayload
    replyToEventId?: string
  }): CollaborationEvent {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM collaboration_events WHERE group_id = ?'
      )
      .get(input.groupId) as { seq: number }
    const event: CollaborationEvent = {
      id: input.id || randomUUID(),
      groupId: input.groupId,
      missionId: input.missionId,
      seq: row.seq,
      actorType: input.actorType,
      actorParticipantId: input.actorParticipantId,
      kind: input.kind,
      payload: input.payload,
      replyToEventId: input.replyToEventId || null,
      createdAt: Date.now()
    }
    this.db
      .prepare(
        `INSERT INTO collaboration_events
         (id, group_id, mission_id, seq, actor_type, actor_participant_id, kind,
          payload_json, reply_to_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.groupId,
        event.missionId,
        event.seq,
        event.actorType,
        event.actorParticipantId,
        event.kind,
        JSON.stringify(event.payload),
        event.replyToEventId,
        event.createdAt
      )
    return event
  }

  private touchGroup(groupId: string): void {
    this.db
      .prepare('UPDATE collaboration_groups SET updated_at = ? WHERE id = ?')
      .run(Date.now(), groupId)
  }
}
