/**
 * Contracts for chats that start other chats. In code a chat is a "session"; one started by
 * another is a worker, the starter is its manager, and the two form a family. The user interface
 * keeps saying "chat". Design: docs/roadmap/MULTI_AGENT.md.
 */
import type { ProjectConversation } from './projects'

/** What a session is doing, computed in the main process for every chat. */
export const SESSION_STATES = [
  'queued',
  'working',
  'waiting',
  'done',
  'idle',
  'failed',
  'stopped'
] as const

export type SessionState = (typeof SESSION_STATES)[number]

/** Who created a chat. Existing chats were all started by the user. */
export const SESSION_STARTER_KINDS = ['user', 'session', 'schedule'] as const

export type SessionStarterKind = (typeof SESSION_STARTER_KINDS)[number]

/**
 * Where a worker does its work: its own managed worktree, the manager's folder (subject to the
 * folder guard), or the manager's folder without write tools.
 */
export const SESSION_WORK_IN = ['worktree', 'folder', 'read-only'] as const

export type SessionWorkIn = (typeof SESSION_WORK_IN)[number]

/**
 * SideKick writes `brief` (a worker's first message, from its manager), `report` (sent for a
 * worker when it goes idle) and `status`. Agents send only `request` (expects a reply and wakes
 * an idle recipient), `response` (wakes a recipient waiting on it) and `update` (never wakes).
 */
export const SESSION_MESSAGE_INTENTS = [
  'brief',
  'request',
  'response',
  'update',
  'report',
  'status'
] as const

export type SessionMessageIntent = (typeof SESSION_MESSAGE_INTENTS)[number]

export const AGENT_SESSION_MESSAGE_INTENTS = ['request', 'response', 'update'] as const

export type AgentSessionMessageIntent = (typeof AGENT_SESSION_MESSAGE_INTENTS)[number]

export const SESSION_PROPOSAL_STATUSES = ['open', 'started', 'dismissed', 'expired'] as const

export type SessionProposalStatus = (typeof SESSION_PROPOSAL_STATUSES)[number]

export const SESSION_LIMITS = {
  /** Runs at once across the app, sessions and sub-agents together. */
  defaultRunSlots: 4,
  maxRunSlots: 8,
  /** Workers in a family that are not archived. */
  liveWorkersPerFamily: 8,
  /** Turns a manager may be woken by other sessions in a row before it waits for the user. */
  automaticTurns: 20,
  queuedMessagesPerRecipient: 50,
  attachmentMaxBytes: 1024 * 1024,
  proposalTtlMs: 7 * 24 * 60 * 60 * 1000,
  handleMaxLength: 32,
  titleMaxLength: 120,
  briefMaxLength: 20_000,
  messageMaxLength: 20_000,
  /** The share of a report shown in the manager's chat; the full text stays in the worker. */
  reportExcerptMaxLength: 2_000
} as const

/** A chat's place in a family, stored on its conversation row. */
export interface SessionLink {
  conversationId: string
  startedByKind: SessionStarterKind
  /** The manager, for a worker. Null for chats the user or a schedule started, and after detach. */
  startedByConversationId: string | null
  /** Where reports go. Null when nothing is reported. */
  reportToConversationId: string | null
  /** Unique among the manager's workers. Null for chats that are not workers. */
  handle: string | null
  workIn: SessionWorkIn | null
  archivedAt: number | null
}

export interface SessionStateCounts {
  queued: number
  working: number
  waiting: number
  done: number
  idle: number
  failed: number
  stopped: number
}

export interface SessionStatus {
  conversationId: string
  state: SessionState
  /** When the chat entered this state. */
  since: number
  /** Short explanation for `waiting`, `failed` and `stopped`, such as "Approval: run npm test". */
  reason?: string
  /** For a manager: the most urgent state among its live workers, and how many are in each. */
  family?: { state: SessionState; counts: SessionStateCounts }
}

export interface SessionFamilyMember extends SessionLink {
  title: string
  projectId: string | null
  projectName: string | null
  state: SessionState
}

/** A manager and the workers it started. Workers cannot start sessions, so it is one level deep. */
export interface SessionFamily {
  rootConversationId: string
  manager: SessionFamilyMember
  workers: SessionFamilyMember[]
}

export interface SessionAttachmentRef {
  id: string
  name: string
  byteSize: number
  sha256: string
}

/** An immutable text snapshot sent with a message, imported by the recipient on request. */
export interface SessionAttachment extends SessionAttachmentRef {
  senderConversationId: string | null
  /** Project-relative path the snapshot was taken from. */
  sourcePath: string
  content: string
  createdAt: number
}

export interface SessionMessage {
  id: string
  /** The chat it is from or on behalf of. Null for SideKick's own status notes. */
  fromConversationId: string | null
  toConversationId: string
  intent: SessionMessageIntent
  body: string
  attachments: SessionAttachmentRef[]
  /** The request this message answers. */
  replyToMessageId: string | null
  createdAt: number
  /** The recipient run that received it. Null while undelivered. */
  deliveredRunId: string | null
  deliveredAt: number | null
  /** When the user saw it in the recipient's chat. */
  readAt: number | null
}

/** One chat to start. Omitted fields follow the manager. */
export interface StartSessionSpec {
  title: string
  /** Defaults to one derived from the title. */
  handle?: string
  /** The worker's first message: the task and what done looks like. */
  brief: string
  /** Defaults to the manager's project. Another project needs a grant. */
  projectId?: string | null
  /** Defaults to `worktree` in a Git project and `folder` elsewhere. */
  workIn?: SessionWorkIn
  /** Branch or commit for a new worktree. */
  baseRef?: string
  modelId?: string
  /** `fork` copies the manager's conversation into the worker first. */
  context?: 'fresh' | 'fork'
}

export interface StartSessionsInput {
  managerConversationId: string
  sessions: StartSessionSpec[]
  /** `propose` leaves cards for the user instead of starting anything. */
  mode?: 'start' | 'propose'
}

export interface StartSessionsResult {
  started: SessionFamilyMember[]
  proposals: SessionProposal[]
}

export interface SessionProposal {
  id: string
  proposerConversationId: string
  spec: StartSessionSpec
  status: SessionProposalStatus
  createdAt: number
  expiresAt: number
  resolvedAt: number | null
  startedConversationId: string | null
}

/** Permission for a manager to start workers in a project other than its own. */
export interface SessionProjectGrant {
  conversationId: string
  projectId: string
  grantedAt: number
  revokedAt: number | null
}

export type SessionsChange = 'status' | 'family' | 'messages' | 'proposals' | 'grants'

export interface SessionsChangedEvent {
  kind: SessionsChange
  /** Chats whose sessions data changed. */
  conversationIds: string[]
  /** Present for `status`: the new statuses of those chats. */
  statuses?: SessionStatus[]
}

export interface SessionsAPI {
  /** Every chat's status that is not `idle`, for the sidebar, badges and the tray. */
  statuses: () => Promise<SessionStatus[]>
  /** The family a chat belongs to, as manager or worker. Null for a chat with no family. */
  family: (conversationId: string) => Promise<SessionFamily | null>
  /** Messages sent to or from a chat, oldest first. */
  messages: (
    conversationId: string,
    options?: { limit?: number; beforeCreatedAt?: number }
  ) => Promise<SessionMessage[]>
  markMessagesRead: (conversationId: string) => Promise<void>
  attachment: (id: string) => Promise<SessionAttachment | null>
  /** Starts workers from the user's own action, such as "New chat from here". */
  start: (input: StartSessionsInput) => Promise<StartSessionsResult>
  proposals: (conversationId: string) => Promise<SessionProposal[]>
  startProposal: (id: string, overrides?: Partial<StartSessionSpec>) => Promise<SessionFamilyMember>
  dismissProposal: (id: string) => Promise<SessionProposal>
  stop: (conversationId: string) => Promise<void>
  /** With `family`, a manager's finished workers are archived with it. */
  archive: (conversationId: string, options?: { family?: boolean }) => Promise<void>
  unarchive: (conversationId: string) => Promise<void>
  /** Turns a worker into an ordinary chat that no longer reports. */
  detach: (conversationId: string) => Promise<void>
  grants: (conversationId: string) => Promise<SessionProjectGrant[]>
  grantProject: (conversationId: string, projectId: string) => Promise<SessionProjectGrant>
  revokeProject: (conversationId: string, projectId: string) => Promise<void>
  onChanged: (callback: (change: SessionsChangedEvent) => void) => () => void
}

/** Reads a chat's family links from its conversation row, filling the defaults of older rows. */
export function sessionLinkFromConversation(conversation: ProjectConversation): SessionLink {
  const kind = conversation.started_by_kind
  const workIn = conversation.work_in
  return {
    conversationId: conversation.id,
    startedByKind: kind && SESSION_STARTER_KINDS.includes(kind) ? kind : 'user',
    startedByConversationId: conversation.started_by_conversation_id ?? null,
    reportToConversationId: conversation.report_to_conversation_id ?? null,
    handle: conversation.session_handle ?? null,
    workIn: workIn && SESSION_WORK_IN.includes(workIn) ? workIn : null,
    archivedAt: conversation.archived_at ?? null
  }
}

/** Most urgent first: what a collapsed family shows on its manager's row. */
const STATE_URGENCY: readonly SessionState[] = [
  'waiting',
  'failed',
  'working',
  'queued',
  'done',
  'stopped',
  'idle'
]

export function mostUrgentSessionState(states: Iterable<SessionState>): SessionState {
  let best = STATE_URGENCY.length - 1
  for (const state of states) best = Math.min(best, STATE_URGENCY.indexOf(state))
  return STATE_URGENCY[best]
}

export function countSessionStates(states: Iterable<SessionState>): SessionStateCounts {
  const counts: SessionStateCounts = {
    queued: 0,
    working: 0,
    waiting: 0,
    done: 0,
    idle: 0,
    failed: 0,
    stopped: 0
  }
  for (const state of states) counts[state] += 1
  return counts
}

/** States in which a worker still occupies a run slot or will soon. */
export function sessionIsActive(state: SessionState): boolean {
  return state === 'queued' || state === 'working' || state === 'waiting'
}

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Why a handle cannot be used, or null. Handles are lowercase words joined by dashes. */
export function sessionHandleProblem(handle: string): string | null {
  if (!handle) return 'Enter a name'
  if (handle.length > SESSION_LIMITS.handleMaxLength)
    return `Names are limited to ${SESSION_LIMITS.handleMaxLength} characters`
  if (!HANDLE_PATTERN.test(handle))
    return 'Use lowercase letters and numbers, with single dashes between words'
  if (handle === 'manager' || handle === 'family') return `“${handle}” is reserved`
  return null
}

/** A free handle derived from a title, numbered when the plain one is taken. */
export function suggestSessionHandle(title: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SESSION_LIMITS.handleMaxLength - 3)
      .replace(/-+$/, '') || 'chat'
  const plain = sessionHandleProblem(base) ? `${base}-chat` : base
  if (!used.has(plain)) return plain
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${plain}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}
