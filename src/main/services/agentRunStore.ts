import type Database from 'better-sqlite3'
import {
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_SURFACES,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunPhase,
  type AgentRunProfile,
  type AgentRunSnapshot,
  type AppendAgentRunEventInput,
  type CreateAgentInteractionInput,
  type PendingAgentInteraction,
  type StartAgentRunInput,
  type ToolExecutionError
} from '../../shared/agentRuntime'

interface AgentRunRow {
  id: string
  thread_id: string
  parent_run_id: string | null
  surface: AgentRunSnapshot['surface']
  phase: AgentRunPhase
  provider: string
  model: string
  workspace_root: string | null
  profile_json: string
  prompt_context_json: string | null
  last_sequence: number
  started_at: number
  updated_at: number
  completed_at: number | null
  error_json: string | null
}

interface AgentRunEventRow {
  id: string
  run_id: string
  sequence: number
  type: AgentRunEventType
  payload_json: string
  timestamp: number
}

interface PendingInteractionRow {
  id: string
  run_id: string
  kind: PendingAgentInteraction['kind']
  status: PendingAgentInteraction['status']
  request_json: string
  response_json: string | null
  created_at: number
  resolved_at: number | null
}

const ACTIVE_PHASES: readonly AgentRunPhase[] = [
  'queued',
  'streaming',
  'awaiting_permission',
  'awaiting_user',
  'executing_tool',
  'compacting',
  'stopping'
]

const TERMINAL_PHASES: readonly AgentRunPhase[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function mapRun(row: AgentRunRow): AgentRunSnapshot {
  const profile = parseJson<AgentRunProfile>(row.profile_json, {
    surface: row.surface,
    executionMode: 'act',
    capabilities: []
  })
  return {
    id: row.id,
    threadId: row.thread_id,
    surface: row.surface,
    executionMode: profile.executionMode === 'plan' ? 'plan' : 'act',
    phase: row.phase,
    provider: row.provider,
    model: row.model,
    lastSequence: row.last_sequence,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_json
      ? { error: parseJson<ToolExecutionError | undefined>(row.error_json, undefined) }
      : {})
  }
}

function mapEvent(row: AgentRunEventRow): AgentRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    timestamp: row.timestamp,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {})
  }
}

function mapInteraction(row: PendingInteractionRow): PendingAgentInteraction {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    request: parseJson<Record<string, unknown>>(row.request_json, {}),
    ...(row.response_json
      ? { response: parseJson<Record<string, unknown>>(row.response_json, {}) }
      : {}),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  }
}

export class AgentRunStore {
  constructor(private readonly db: Database.Database) {}

  start(input: StartAgentRunInput): AgentRunSnapshot {
    if (!AGENT_RUN_SURFACES.includes(input.profile.surface)) {
      throw new Error(`Invalid agent run surface: ${input.profile.surface}`)
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_runs
           (id, thread_id, parent_run_id, surface, phase, provider, model, workspace_root,
            profile_json, prompt_context_json, last_sequence, started_at, updated_at,
            completed_at, error_json)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`
        )
        .run(
          input.id,
          input.threadId,
          input.parentRunId ?? null,
          input.profile.surface,
          input.provider,
          input.model,
          input.workspaceRoot ?? null,
          JSON.stringify(input.profile),
          input.promptContext ? JSON.stringify(input.promptContext) : null,
          now,
          now
        )
      this.appendEventRow({
        id: `${input.id}:started`,
        runId: input.id,
        type: 'run.started',
        payload: {
          threadId: input.threadId,
          surface: input.profile.surface,
          executionMode: input.profile.executionMode,
          capabilities: input.profile.capabilities,
          provider: input.provider,
          model: input.model,
          workspaceRoot: input.workspaceRoot ?? null,
          outputMessageId: input.outputMessageId ?? null,
          parentRunId: input.parentRunId ?? null
        },
        timestamp: now
      })
    })()
    return this.get(input.id)!
  }

  private appendEventRow(input: AppendAgentRunEventInput): AgentRunEvent {
    if (!AGENT_RUN_EVENT_TYPES.includes(input.type)) {
      throw new Error(`Invalid agent run event: ${input.type}`)
    }
    const run = this.db
      .prepare('SELECT last_sequence FROM agent_runs WHERE id = ?')
      .get(input.runId) as { last_sequence: number } | undefined
    if (!run) throw new Error(`Agent run not found: ${input.runId}`)
    const sequence = run.last_sequence + 1
    const timestamp = input.timestamp ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO agent_run_events (id, run_id, sequence, type, payload_json, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.id, input.runId, sequence, input.type, JSON.stringify(input.payload), timestamp)
    this.db
      .prepare('UPDATE agent_runs SET last_sequence = ?, updated_at = ? WHERE id = ?')
      .run(sequence, timestamp, input.runId)
    return {
      id: input.id,
      runId: input.runId,
      sequence,
      type: input.type,
      timestamp,
      payload: input.payload
    }
  }

  appendEvent(input: AppendAgentRunEventInput): AgentRunEvent {
    return this.db.transaction(() => this.appendEventRow(input))()
  }

  transition(
    runId: string,
    phase: AgentRunPhase,
    eventId: string,
    error?: ToolExecutionError
  ): AgentRunSnapshot {
    return this.db.transaction(() => {
      const current = this.get(runId)
      if (!current) throw new Error(`Agent run not found: ${runId}`)
      if (TERMINAL_PHASES.includes(current.phase)) {
        throw new Error(`Agent run is already terminal: ${current.phase}`)
      }
      const now = Date.now()
      const terminal = TERMINAL_PHASES.includes(phase)
      this.db
        .prepare(
          `UPDATE agent_runs
           SET phase = ?, updated_at = ?, completed_at = ?, error_json = ?
           WHERE id = ?`
        )
        .run(phase, now, terminal ? now : null, error ? JSON.stringify(error) : null, runId)
      if (phase === 'completed' && current.surface === 'conversation') {
        this.db
          .prepare('UPDATE conversations SET unread_completion_at = ? WHERE id = ?')
          .run(now, current.threadId)
      }
      this.appendEventRow({
        id: eventId,
        runId,
        type: terminal ? 'run.completed' : 'run.phase',
        payload: { phase, ...(error ? { error } : {}) },
        timestamp: now
      })
      return this.get(runId)!
    })()
  }

  get(id: string): AgentRunSnapshot | null {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
      | AgentRunRow
      | undefined
    return row ? mapRun(row) : null
  }

  profile(id: string): AgentRunProfile | null {
    const row = this.db.prepare('SELECT profile_json FROM agent_runs WHERE id = ?').get(id) as
      | { profile_json: string }
      | undefined
    return row ? parseJson<AgentRunProfile | null>(row.profile_json, null) : null
  }

  updateRuntime(
    runId: string,
    input: {
      profile: AgentRunProfile
      provider: string
      model: string
      from: 'act' | 'plan'
      to: 'act' | 'plan'
      revision?: string
    }
  ): AgentRunSnapshot {
    return this.db.transaction(() => {
      const current = this.get(runId)
      if (!current) throw new Error(`Agent run not found: ${runId}`)
      const now = Date.now()
      this.db
        .prepare(
          `UPDATE agent_runs
           SET profile_json = ?, provider = ?, model = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(JSON.stringify(input.profile), input.provider, input.model, now, runId)
      this.appendEventRow({
        id: `${runId}:plan-mode:${now}`,
        runId,
        type: 'plan.mode_changed',
        payload: {
          from: input.from,
          to: input.to,
          provider: input.provider,
          model: input.model,
          capabilities: input.profile.capabilities,
          revision: input.revision ?? null
        },
        timestamp: now
      })
      return this.get(runId)!
    })()
  }

  latest(threadId: string): AgentRunSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(threadId) as AgentRunRow | undefined
    return row ? mapRun(row) : null
  }

  listEvents(runId: string, afterSequence = 0, limit = 1_000): AgentRunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(
        runId,
        Math.max(0, afterSequence),
        Math.max(1, Math.min(10_000, limit))
      ) as AgentRunEventRow[]
    return rows.map(mapEvent)
  }

  createInteraction(input: CreateAgentInteractionInput): PendingAgentInteraction {
    const now = Date.now()
    this.db.transaction(() => {
      if (!this.get(input.runId)) throw new Error(`Agent run not found: ${input.runId}`)
      this.db
        .prepare(
          `INSERT INTO agent_pending_interactions
           (id, run_id, kind, status, request_json, response_json, created_at, resolved_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, ?, NULL)`
        )
        .run(input.id, input.runId, input.kind, JSON.stringify(input.request), now)
      this.appendEventRow({
        id: `${input.id}:requested`,
        runId: input.runId,
        type: input.kind === 'permission' ? 'permission.requested' : 'question.requested',
        payload: { interactionId: input.id, kind: input.kind, request: input.request },
        timestamp: now
      })
    })()
    return this.getInteraction(input.id)!
  }

  resolveInteraction(
    id: string,
    response: Record<string, unknown>,
    cancelled = false
  ): PendingAgentInteraction {
    return this.db.transaction(() => {
      const current = this.getInteraction(id)
      if (!current) throw new Error(`Agent interaction not found: ${id}`)
      if (current.status !== 'pending') throw new Error('Agent interaction is already resolved')
      const now = Date.now()
      this.db
        .prepare(
          `UPDATE agent_pending_interactions
           SET status = ?, response_json = ?, resolved_at = ? WHERE id = ?`
        )
        .run(cancelled ? 'cancelled' : 'resolved', JSON.stringify(response), now, id)
      this.appendEventRow({
        id: `${id}:resolved`,
        runId: current.runId,
        type: current.kind === 'permission' ? 'permission.resolved' : 'question.resolved',
        payload: {
          interactionId: id,
          kind: current.kind,
          status: cancelled ? 'cancelled' : 'resolved',
          response
        },
        timestamp: now
      })
      return this.getInteraction(id)!
    })()
  }

  getInteraction(id: string): PendingAgentInteraction | null {
    const row = this.db.prepare('SELECT * FROM agent_pending_interactions WHERE id = ?').get(id) as
      | PendingInteractionRow
      | undefined
    return row ? mapInteraction(row) : null
  }

  listPendingInteractions(runId?: string): PendingAgentInteraction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_pending_interactions
         WHERE status = 'pending' AND (? IS NULL OR run_id = ?)
         ORDER BY created_at ASC`
      )
      .all(runId ?? null, runId ?? null) as PendingInteractionRow[]
    return rows.map(mapInteraction)
  }

  recoverInterrupted(threadId?: string): AgentRunSnapshot[] {
    const placeholders = ACTIVE_PHASES.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE phase IN (${placeholders}) AND (? IS NULL OR thread_id = ?)
         ORDER BY started_at ASC`
      )
      .all(...ACTIVE_PHASES, threadId ?? null, threadId ?? null) as AgentRunRow[]
    if (!rows.length) return []
    const now = Date.now()
    this.db.transaction(() => {
      for (const row of rows) {
        const pendingInteractions = this.db
          .prepare(
            `SELECT * FROM agent_pending_interactions
             WHERE run_id = ? AND status = 'pending'
             ORDER BY created_at ASC`
          )
          .all(row.id) as PendingInteractionRow[]
        const error: ToolExecutionError = {
          code: 'cancelled',
          message: 'Run interrupted before completion',
          retryable: true,
          recoveryAction: 'refresh_state',
          recovery: 'Resume from the durable event stream.'
        }
        this.db
          .prepare(
            `UPDATE agent_runs
             SET phase = 'interrupted', updated_at = ?, completed_at = ?, error_json = ?
             WHERE id = ?`
          )
          .run(now, now, JSON.stringify(error), row.id)
        this.db
          .prepare(
            `UPDATE agent_pending_interactions
             SET status = 'cancelled', response_json = ?, resolved_at = ?
             WHERE run_id = ? AND status = 'pending'`
          )
          .run(JSON.stringify({ reason: 'run_interrupted' }), now, row.id)
        for (const pending of pendingInteractions) {
          this.appendEventRow({
            id: `${pending.id}:interrupted:${now}`,
            runId: row.id,
            type: pending.kind === 'permission' ? 'permission.resolved' : 'question.resolved',
            payload: {
              interactionId: pending.id,
              kind: pending.kind,
              status: 'cancelled',
              response: { reason: 'run_interrupted' }
            },
            timestamp: now
          })
        }
        this.appendEventRow({
          id: `${row.id}:interrupted:${now}`,
          runId: row.id,
          type: 'run.completed',
          payload: { phase: 'interrupted', error },
          timestamp: now
        })
      }
    })()
    return rows.map(({ id }) => this.get(id)!).filter(Boolean)
  }
}
