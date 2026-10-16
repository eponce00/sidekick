import type Database from 'better-sqlite3'
import type { AgentRunEvent, AgentRunEventType } from '../../shared/agentRuntime'
import type { ConversationAttentionAlert } from '../../shared/conversationAttention'
import {
  countSessionStates,
  mostUrgentSessionState,
  type SessionState,
  type SessionStateCounts,
  type SessionStatus,
  type SessionsChangedEvent
} from '../../shared/sessions'
import { ConversationAttentionTracker, type AttentionRunIdentity } from './conversationAttention'

/** What the database says about a chat when no run of it is live. */
export interface SessionDurableFacts {
  conversationId: string
  /** The chat that started it, for a worker. */
  startedByConversationId: string | null
  archivedAt: number | null
  unreadCompletionAt: number | null
  /** Its latest chat or research run, if it ever had one. */
  lastRun: { phase: string; endedAt: number; errorMessage: string | null } | null
}

export interface SessionStatusSources {
  /** The thread and surface of a run, or null once it is unknown. */
  runIdentity: (runId: string) => AttentionRunIdentity | null
  /** Chats with a chat or research run preparing or running. */
  activeConversationIds: () => string[]
  /** Facts for the given chats, or for every chat. Missing chats were deleted. */
  durableFacts: (conversationIds?: readonly string[]) => SessionDurableFacts[]
  /** Live workers of the given managers. */
  workerIds: (managerIds: readonly string[]) => Map<string, string[]>
  now?: () => number
}

// Streaming deltas and tool output cannot change a chat's state; skipping them keeps the
// service off the database while a reply streams.
const STATE_EVENTS: ReadonlySet<AgentRunEventType> = new Set([
  'run.started',
  'run.phase',
  'run.completed',
  'run.finalized',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved'
])

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const REASON_MAX_LENGTH = 120

function shortReason(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > REASON_MAX_LENGTH ? `${line.slice(0, REASON_MAX_LENGTH - 1)}…` : line
}

interface OwnStatus {
  state: SessionState
  since: number
  reason?: string
}

/**
 * The one place that knows what every chat is doing: `working` while a run prepares or runs,
 * `waiting` while it is paused on the user, `done` until a finished reply is read, `failed` or
 * `stopped` after its last run ended that way, and `idle` otherwise. A manager also carries the
 * most urgent state of its live workers. The sidebar, the badge, the tray and notifications all
 * read it, so a run started from the main process shows the same way as one started from a chat.
 */
export class SessionStatusService {
  private readonly own = new Map<string, OwnStatus>()
  private readonly published = new Map<string, SessionStatus>()
  private readonly listeners = new Set<(event: SessionsChangedEvent) => void>()
  private readonly attention: ConversationAttentionTracker
  private readonly now: () => number
  private pendingAlert: ConversationAttentionAlert | undefined

  constructor(private readonly sources: SessionStatusSources) {
    this.now = sources.now ?? Date.now
    this.attention = new ConversationAttentionTracker(sources.runIdentity, (state) => {
      if (state.alert) this.pendingAlert = state.alert
    })
  }

  /** Computes every chat from the database, so states are right before any window asks. */
  start(): void {
    this.recompute(null)
  }

  observe(event: AgentRunEvent): void {
    if (!STATE_EVENTS.has(event.type)) return
    this.attention.observe(event)
    const run = this.sources.runIdentity(event.runId)
    if (!run || run.surface === 'collaboration') {
      this.flushAlert()
      return
    }
    this.recompute([run.threadId])
  }

  /** Re-reads chats whose stored facts changed: read, deleted, moved, or a run preparing. */
  refresh(conversationIds: readonly string[]): void {
    if (conversationIds.length) this.recompute(conversationIds)
  }

  /** Every chat whose state, or whose family's, is not `idle`. */
  statuses(): SessionStatus[] {
    return [...this.published.values()]
  }

  status(conversationId: string): SessionStatus | null {
    return this.published.get(conversationId) ?? null
  }

  /** Chats paused on the user, the longest waiting first. */
  waitingConversationIds(): string[] {
    return [...this.own.entries()]
      .filter(([, status]) => status.state === 'waiting')
      .sort(([, a], [, b]) => a.since - b.since)
      .map(([id]) => id)
  }

  counts(): SessionStateCounts {
    return countSessionStates([...this.own.values()].map(({ state }) => state))
  }

  onChange(listener: (event: SessionsChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private ownStatus(
    facts: SessionDurableFacts | undefined,
    active: ReadonlySet<string>,
    id: string
  ) {
    const previous = this.own.get(id)
    const keep = (state: SessionState, reason?: string): OwnStatus | null =>
      state === 'idle'
        ? null
        : {
            state,
            since: previous?.state === state ? previous.since : this.now(),
            ...(reason ? { reason } : {})
          }
    if (!facts) return null
    const waiting = this.attention.waitingReason(id)
    if (waiting) return keep('waiting', waiting === 'question' ? 'Question' : 'Approval')
    if (active.has(id)) return keep('working')
    const run = facts.lastRun
    if (run && !TERMINAL_PHASES.has(run.phase)) return keep('failed', 'Interrupted')
    if (run?.phase === 'failed') return keep('failed', shortReason(run.errorMessage ?? 'Failed'))
    if (run?.phase === 'interrupted') return keep('failed', 'Interrupted')
    if (run?.phase === 'cancelled') return keep('stopped', 'Stopped')
    if (facts.unreadCompletionAt) return keep('done')
    return null
  }

  /** `null` recomputes every chat. */
  private recompute(ids: readonly string[] | null): void {
    const facts = this.sources.durableFacts(ids ?? undefined)
    const factsById = new Map(facts.map((fact) => [fact.conversationId, fact]))
    const active = new Set(this.sources.activeConversationIds())
    const targets = ids ?? [
      ...new Set([...facts.map((fact) => fact.conversationId), ...this.own.keys()])
    ]
    const touched = new Set<string>()
    for (const id of targets) {
      const fact = factsById.get(id)
      const next = this.ownStatus(fact, active, id)
      if (next) this.own.set(id, next)
      else this.own.delete(id)
      touched.add(id)
      const manager = fact?.startedByConversationId
      if (manager) touched.add(manager)
    }
    this.publish(touched, ids === null)
  }

  private publish(touched: ReadonlySet<string>, everything: boolean): void {
    const workers = this.sources.workerIds([...touched])
    const changed: SessionStatus[] = []
    const changedIds: string[] = []
    const candidates = everything ? new Set([...touched, ...this.published.keys()]) : touched
    for (const id of candidates) {
      const own = this.own.get(id)
      const familyIds = workers.get(id) ?? []
      const familyStates = familyIds.map((worker) => this.own.get(worker)?.state ?? 'idle')
      const familyState = familyStates.length ? mostUrgentSessionState(familyStates) : 'idle'
      const next: SessionStatus | null =
        own || familyState !== 'idle'
          ? {
              conversationId: id,
              state: own?.state ?? 'idle',
              since: own?.since ?? this.now(),
              ...(own?.reason ? { reason: own.reason } : {}),
              ...(familyStates.length && familyState !== 'idle'
                ? { family: { state: familyState, counts: countSessionStates(familyStates) } }
                : {})
            }
          : null
      const previous = this.published.get(id)
      if (JSON.stringify(previous ?? null) === JSON.stringify(next)) continue
      if (next) this.published.set(id, next)
      else this.published.delete(id)
      changedIds.push(id)
      changed.push(next ?? { conversationId: id, state: 'idle', since: this.now() })
    }
    const alert = this.takeAlert()
    if (!changed.length && !alert) return
    this.emit({
      kind: 'status',
      conversationIds: changedIds,
      statuses: changed,
      ...(alert ? { alerts: [alert] } : {})
    })
  }

  private takeAlert(): ConversationAttentionAlert | undefined {
    const alert = this.pendingAlert
    this.pendingAlert = undefined
    return alert
  }

  private flushAlert(): void {
    const alert = this.takeAlert()
    if (alert) this.emit({ kind: 'status', conversationIds: [], statuses: [], alerts: [alert] })
  }

  private emit(event: SessionsChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[Sessions] A status listener failed:', error)
      }
    }
  }
}

function errorMessage(json: string | null): string | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as { message?: unknown }
    return typeof value.message === 'string' ? value.message : null
  } catch {
    return null
  }
}

/** Reads the facts the service needs from SideKick's database. */
export function databaseSessionSources(
  db: Database.Database
): Pick<SessionStatusSources, 'durableFacts' | 'workerIds'> {
  const factsSql = `
    SELECT c.id, c.started_by_conversation_id, c.archived_at, c.unread_completion_at,
           r.phase, COALESCE(r.completed_at, r.updated_at) AS ended_at, r.error_json
    FROM conversations c
    LEFT JOIN agent_runs r ON r.id = (
      SELECT id FROM agent_runs
      WHERE thread_id = c.id AND parent_run_id IS NULL AND surface IN ('conversation', 'research')
      ORDER BY started_at DESC LIMIT 1
    )`
  type Row = {
    id: string
    started_by_conversation_id: string | null
    archived_at: number | null
    unread_completion_at: number | null
    phase: string | null
    ended_at: number | null
    error_json: string | null
  }
  const toFacts = (row: Row): SessionDurableFacts => ({
    conversationId: row.id,
    startedByConversationId: row.started_by_conversation_id,
    archivedAt: row.archived_at,
    unreadCompletionAt: row.unread_completion_at,
    lastRun: row.phase
      ? { phase: row.phase, endedAt: row.ended_at ?? 0, errorMessage: errorMessage(row.error_json) }
      : null
  })
  return {
    durableFacts: (ids) => {
      if (!ids) return (db.prepare(factsSql).all() as Row[]).map(toFacts)
      if (!ids.length) return []
      const placeholders = ids.map(() => '?').join(', ')
      return (db.prepare(`${factsSql} WHERE c.id IN (${placeholders})`).all(...ids) as Row[]).map(
        toFacts
      )
    },
    workerIds: (managerIds) => {
      const workers = new Map<string, string[]>()
      if (!managerIds.length) return workers
      const placeholders = managerIds.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT id, started_by_conversation_id AS manager FROM conversations
           WHERE archived_at IS NULL AND started_by_conversation_id IN (${placeholders})`
        )
        .all(...managerIds) as { id: string; manager: string }[]
      for (const { id, manager } of rows)
        workers.set(manager, [...(workers.get(manager) ?? []), id])
      return workers
    }
  }
}
