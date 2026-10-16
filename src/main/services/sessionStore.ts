import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { ProjectConversation } from '../../shared/projects'
import { ProjectStore } from './projectStore'
import {
  SESSION_LIMITS,
  type SessionAttachment,
  type SessionAttachmentRef,
  type SessionMessage,
  type SessionMessageIntent,
  type SessionProjectGrant,
  type SessionProposal,
  type SessionProposalStatus,
  type StartSessionSpec
} from '../../shared/sessions'

interface MessageRow {
  id: string
  from_conversation_id: string | null
  to_conversation_id: string
  intent: SessionMessageIntent
  body: string
  attachments_json: string
  reply_to_message_id: string | null
  created_at: number
  delivered_run_id: string | null
  delivered_at: number | null
  read_at: number | null
}

interface ProposalRow {
  id: string
  proposer_conversation_id: string
  spec_json: string
  status: SessionProposalStatus
  created_at: number
  expires_at: number
  resolved_at: number | null
  started_conversation_id: string | null
}

interface GrantRow {
  conversation_id: string
  project_id: string
  granted_at: number
  revoked_at: number | null
}

function parseAttachments(json: string): SessionAttachmentRef[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? (parsed as SessionAttachmentRef[]) : []
  } catch {
    return []
  }
}

function message(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    fromConversationId: row.from_conversation_id,
    toConversationId: row.to_conversation_id,
    intent: row.intent,
    body: row.body,
    attachments: parseAttachments(row.attachments_json),
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
    deliveredRunId: row.delivered_run_id,
    deliveredAt: row.delivered_at,
    readAt: row.read_at
  }
}

function proposal(row: ProposalRow): SessionProposal {
  return {
    id: row.id,
    proposerConversationId: row.proposer_conversation_id,
    spec: JSON.parse(row.spec_json) as StartSessionSpec,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    startedConversationId: row.started_conversation_id
  }
}

function grant(row: GrantRow): SessionProjectGrant {
  return {
    conversationId: row.conversation_id,
    projectId: row.project_id,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at
  }
}

export interface NewSessionMessage {
  id?: string
  fromConversationId: string | null
  toConversationId: string
  intent: SessionMessageIntent
  body: string
  attachments?: SessionAttachmentRef[]
  replyToMessageId?: string | null
  /** Set when the message is already part of a run, such as a brief. */
  deliveredRunId?: string
}

/** Durable rows for families: links on conversations, messages, proposals and grants. */
export class SessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  conversation(id: string): ProjectConversation | null {
    return (
      (this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        | ProjectConversation
        | undefined) ?? null
    )
  }

  projects(): Array<{ id: string; name: string }> {
    return this.db
      .prepare('SELECT id, name FROM projects ORDER BY name COLLATE NOCASE')
      .all() as Array<{
      id: string
      name: string
    }>
  }

  /** The folder a chat works in, from its project, or undefined for a chat without one. */
  workspaceRoot(conversationId: string): string | undefined {
    return (
      new ProjectStore(this.db).getConversationContext(conversationId).workspaceRoot ?? undefined
    )
  }

  /** Workers a manager started, oldest first, archived ones included when asked. */
  workers(managerId: string, includeArchived = false): ProjectConversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations WHERE started_by_conversation_id = ?
         ${includeArchived ? '' : 'AND archived_at IS NULL'}
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(managerId) as ProjectConversation[]
  }

  setArchived(ids: readonly string[], archivedAt: number | null): void {
    const update = this.db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) update.run(archivedAt, id)
    })()
  }

  detach(id: string): void {
    this.db
      .prepare(
        `UPDATE conversations
         SET started_by_conversation_id = NULL, report_to_conversation_id = NULL
         WHERE id = ?`
      )
      .run(id)
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  insertMessage(input: NewSessionMessage): SessionMessage {
    const timestamp = this.now()
    const id = input.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO session_messages
         (id, from_conversation_id, to_conversation_id, intent, body, attachments_json,
          reply_to_message_id, created_at, delivered_run_id, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.fromConversationId,
        input.toConversationId,
        input.intent,
        input.body,
        JSON.stringify(input.attachments ?? []),
        input.replyToMessageId ?? null,
        timestamp,
        input.deliveredRunId ?? null,
        input.deliveredRunId ? timestamp : null
      )
    return this.message(id)!
  }

  message(id: string): SessionMessage | null {
    const row = this.db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? message(row) : null
  }

  /** Messages to or from a chat, oldest first. */
  messages(
    conversationId: string,
    options: { limit?: number; beforeCreatedAt?: number } = {}
  ): SessionMessage[] {
    const limit = Math.min(Math.max(1, options.limit ?? 200), 500)
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, rowid AS position FROM session_messages
           WHERE (to_conversation_id = ? OR from_conversation_id = ?) AND created_at < ?
           ORDER BY created_at DESC, position DESC LIMIT ?
         ) ORDER BY created_at ASC, position ASC`
      )
      .all(
        conversationId,
        conversationId,
        options.beforeCreatedAt ?? Number.MAX_SAFE_INTEGER,
        limit
      ) as MessageRow[]
    return rows.map(message)
  }

  undelivered(conversationId: string): SessionMessage[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM session_messages
           WHERE to_conversation_id = ? AND delivered_at IS NULL
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(conversationId) as MessageRow[]
    ).map(message)
  }

  undeliveredCount(conversationId: string): number {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS count FROM session_messages
           WHERE to_conversation_id = ? AND delivered_at IS NULL`
        )
        .get(conversationId) as { count: number }
    ).count
  }

  markDelivered(id: string, runId: string): void {
    this.db
      .prepare(
        `UPDATE session_messages SET delivered_run_id = ?, delivered_at = ?
         WHERE id = ? AND delivered_at IS NULL`
      )
      .run(runId, this.now(), id)
  }

  /** Requests a run received and did not answer before it ended. */
  unansweredRequests(runId: string, recipientId: string): SessionMessage[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM session_messages request
           WHERE request.delivered_run_id = ? AND request.to_conversation_id = ?
             AND request.intent = 'request'
             AND NOT EXISTS (
               SELECT 1 FROM session_messages reply
               WHERE reply.reply_to_message_id = request.id
                 AND reply.from_conversation_id = request.to_conversation_id
             )
           ORDER BY request.created_at ASC`
        )
        .all(runId, recipientId) as MessageRow[]
    ).map(message)
  }

  markRead(conversationId: string): void {
    this.db
      .prepare(
        `UPDATE session_messages SET read_at = ?
         WHERE to_conversation_id = ? AND read_at IS NULL`
      )
      .run(this.now(), conversationId)
  }

  attachment(id: string): SessionAttachment | null {
    const row = this.db.prepare('SELECT * FROM session_attachments WHERE id = ?').get(id) as
      | {
          id: string
          sender_conversation_id: string | null
          name: string
          source_path: string
          content: string
          byte_size: number
          sha256: string
          created_at: number
        }
      | undefined
    return row
      ? {
          id: row.id,
          senderConversationId: row.sender_conversation_id,
          name: row.name,
          sourcePath: row.source_path,
          content: row.content,
          byteSize: row.byte_size,
          sha256: row.sha256,
          createdAt: row.created_at
        }
      : null
  }

  insertAttachment(input: {
    senderConversationId: string
    name: string
    sourcePath: string
    content: string
    sha256: string
  }): SessionAttachment {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO session_attachments
         (id, sender_conversation_id, name, source_path, content, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.senderConversationId,
        input.name,
        input.sourcePath,
        input.content,
        Buffer.byteLength(input.content, 'utf8'),
        input.sha256,
        this.now()
      )
    return this.attachment(id)!
  }

  /** An attachment sent to this chat with a message, or null when it was not. */
  attachmentFor(conversationId: string, attachmentId: string): SessionAttachment | null {
    const rows = this.db
      .prepare('SELECT attachments_json FROM session_messages WHERE to_conversation_id = ?')
      .all(conversationId) as Array<{ attachments_json: string }>
    const received = rows.some(({ attachments_json }) =>
      parseAttachments(attachments_json).some(({ id }) => id === attachmentId)
    )
    return received ? this.attachment(attachmentId) : null
  }

  insertProposal(proposerConversationId: string, spec: StartSessionSpec): SessionProposal {
    const id = randomUUID()
    const createdAt = this.now()
    this.db
      .prepare(
        `INSERT INTO session_proposals
         (id, proposer_conversation_id, spec_json, status, created_at, expires_at)
         VALUES (?, ?, ?, 'open', ?, ?)`
      )
      .run(
        id,
        proposerConversationId,
        JSON.stringify(spec),
        createdAt,
        createdAt + SESSION_LIMITS.proposalTtlMs
      )
    return this.proposal(id)!
  }

  /** A proposal, with an open one past its expiry marked expired. */
  proposal(id: string): SessionProposal | null {
    this.expireProposals()
    const row = this.db.prepare('SELECT * FROM session_proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined
    return row ? proposal(row) : null
  }

  proposals(proposerConversationId: string): SessionProposal[] {
    this.expireProposals()
    return (
      this.db
        .prepare(
          `SELECT * FROM session_proposals WHERE proposer_conversation_id = ?
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(proposerConversationId) as ProposalRow[]
    ).map(proposal)
  }

  resolveProposal(
    id: string,
    status: Exclude<SessionProposalStatus, 'open'>,
    startedConversationId: string | null = null
  ): SessionProposal {
    const result = this.db
      .prepare(
        `UPDATE session_proposals SET status = ?, resolved_at = ?, started_conversation_id = ?
         WHERE id = ? AND status = 'open'`
      )
      .run(status, this.now(), startedConversationId, id)
    if (result.changes !== 1) throw new Error('This suggestion is no longer open')
    return this.proposal(id)!
  }

  private expireProposals(): void {
    this.db
      .prepare(
        `UPDATE session_proposals SET status = 'expired', resolved_at = ?
         WHERE status = 'open' AND expires_at <= ?`
      )
      .run(this.now(), this.now())
  }

  grants(conversationId: string): SessionProjectGrant[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM session_project_grants WHERE conversation_id = ?
           ORDER BY granted_at ASC`
        )
        .all(conversationId) as GrantRow[]
    ).map(grant)
  }

  hasGrant(conversationId: string, projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM session_project_grants
           WHERE conversation_id = ? AND project_id = ? AND revoked_at IS NULL`
        )
        .get(conversationId, projectId)
    )
  }

  grantProject(conversationId: string, projectId: string): SessionProjectGrant {
    this.db
      .prepare(
        `INSERT INTO session_project_grants (conversation_id, project_id, granted_at)
         VALUES (?, ?, ?)
         ON CONFLICT (conversation_id, project_id)
         DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`
      )
      .run(conversationId, projectId, this.now())
    return this.grants(conversationId).find((entry) => entry.projectId === projectId)!
  }

  revokeProject(conversationId: string, projectId: string): void {
    this.db
      .prepare(
        `UPDATE session_project_grants SET revoked_at = ?
         WHERE conversation_id = ? AND project_id = ? AND revoked_at IS NULL`
      )
      .run(this.now(), conversationId, projectId)
  }
}
