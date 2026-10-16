import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { AgentRunPhase } from '../../shared/agentRuntime'
import {
  ACTIVE_SCHEDULED_RUN_PHASES,
  type Schedule,
  type ScheduleCadence,
  type ScheduleInput,
  type ScheduleRun,
  type ScheduleRunOutcome
} from '../../shared/schedules'

interface ScheduleRow {
  id: string
  name: string
  prompt: string
  project_id: string | null
  model_id: string
  cadence: ScheduleCadence
  hour: number
  minute: number
  weekday: number
  catch_up: number
  enabled: number
  paused_reason: string | null
  next_run_at: number | null
  last_run_at: number | null
  run_count: number
  created_at: number
  updated_at: number
}

interface ScheduleRunRow {
  id: string
  schedule_id: string
  run_number: number | null
  scheduled_for: number
  started_at: number | null
  outcome: ScheduleRunOutcome
  trigger: 'schedule' | 'manual'
  late: number
  reason: string | null
  conversation_id: string | null
  agent_run_id: string | null
  agent_phase: AgentRunPhase | null
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    projectId: row.project_id,
    modelId: row.model_id,
    cadence: row.cadence,
    hour: row.hour,
    minute: row.minute,
    weekday: row.weekday,
    catchUp: row.catch_up === 1,
    enabled: row.enabled === 1,
    ...(row.paused_reason ? { pausedReason: row.paused_reason } : {}),
    nextRunAt: row.next_run_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    ...(row.run_number !== null ? { runNumber: row.run_number } : {}),
    scheduledFor: row.scheduled_for,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    outcome: row.outcome,
    trigger: row.trigger,
    late: row.late === 1,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.agent_run_id ? { agentRunId: row.agent_run_id } : {}),
    ...(row.agent_phase && row.conversation_id ? { agentPhase: row.agent_phase } : {})
  }
}

export interface RecordScheduleRunInput {
  scheduleId: string
  scheduledFor: number
  outcome: ScheduleRunOutcome
  trigger: 'schedule' | 'manual'
  late: boolean
  reason?: string
  runNumber?: number
  startedAt?: number
  conversationId?: string
  agentRunId?: string
}

/** Kept per schedule; older skipped and failed rows say little once newer ones exist. */
const RUN_HISTORY_LIMIT = 200

export class ScheduleStore {
  constructor(private readonly db: Database.Database) {}

  list(): Schedule[] {
    return (
      this.db
        .prepare('SELECT * FROM schedules ORDER BY created_at ASC, id ASC')
        .all() as ScheduleRow[]
    ).map((row) => this.withActiveRun(toSchedule(row)))
  }

  get(id: string): Schedule | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      | ScheduleRow
      | undefined
    return row ? this.withActiveRun(toSchedule(row)) : undefined
  }

  private withActiveRun(schedule: Schedule): Schedule {
    const latest = this.latestStartedRun(schedule.id)
    return latest?.conversationId &&
      latest.agentRunId &&
      latest.agentPhase &&
      ACTIVE_SCHEDULED_RUN_PHASES.includes(latest.agentPhase)
      ? {
          ...schedule,
          activeRun: {
            conversationId: latest.conversationId,
            agentRunId: latest.agentRunId,
            phase: latest.agentPhase
          }
        }
      : schedule
  }

  create(input: ScheduleInput, nextRunAt: number, now: number): Schedule {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO schedules
         (id, name, prompt, project_id, model_id, cadence, hour, minute, weekday, catch_up,
          enabled, next_run_at, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.prompt,
        input.projectId,
        input.modelId,
        input.cadence,
        input.hour,
        input.minute,
        input.weekday,
        input.catchUp ? 1 : 0,
        nextRunAt,
        now,
        now
      )
    return this.get(id)!
  }

  /** `nextRunAt` is null when the schedule stays paused. */
  update(id: string, input: ScheduleInput, nextRunAt: number | null, now: number): Schedule {
    const result = this.db
      .prepare(
        `UPDATE schedules
         SET name = ?, prompt = ?, project_id = ?, model_id = ?, cadence = ?, hour = ?,
             minute = ?, weekday = ?, catch_up = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name,
        input.prompt,
        input.projectId,
        input.modelId,
        input.cadence,
        input.hour,
        input.minute,
        input.weekday,
        input.catchUp ? 1 : 0,
        nextRunAt,
        now,
        id
      )
    if (!result.changes) throw new Error('Schedule not found')
    return this.get(id)!
  }

  resume(id: string, nextRunAt: number, now: number): Schedule {
    const result = this.db
      .prepare(
        `UPDATE schedules
         SET enabled = 1, paused_reason = NULL, next_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextRunAt, now, id)
    if (!result.changes) throw new Error('Schedule not found')
    return this.get(id)!
  }

  pause(id: string, now: number, reason?: string): Schedule {
    const result = this.db
      .prepare(
        `UPDATE schedules
         SET enabled = 0, paused_reason = ?, next_run_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(reason ?? null, now, id)
    if (!result.changes) throw new Error('Schedule not found')
    return this.get(id)!
  }

  /** Keeps the chats a schedule created, as ordinary chats. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE conversations SET schedule_id = NULL, schedule_run_number = NULL
           WHERE schedule_id = ?`
        )
        .run(id)
      return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
    })()
  }

  /** Enabled schedules whose time has come, earliest first. */
  due(now: number): Schedule[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM schedules
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at ASC, id ASC`
        )
        .all(now) as ScheduleRow[]
    ).map(toSchedule)
  }

  earliestNextRunAt(): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(next_run_at) AS next FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL`
      )
      .get() as { next: number | null }
    return row.next
  }

  /**
   * Moves a due schedule to its next time, only if it is still due at `expected`. A schedule
   * edited or advanced meanwhile is left alone, so one occurrence cannot start twice.
   */
  advance(id: string, expected: number, nextRunAt: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE schedules SET next_run_at = ?
           WHERE id = ? AND enabled = 1 AND next_run_at = ?`
        )
        .run(nextRunAt, id, expected).changes > 0
    )
  }

  /** Reserves the next run number. Numbers count started runs only, so they have no gaps. */
  claimRunNumber(id: string, now: number): number {
    return this.db.transaction(() => {
      const result = this.db
        .prepare('UPDATE schedules SET run_count = run_count + 1, last_run_at = ? WHERE id = ?')
        .run(now, id)
      if (!result.changes) throw new Error('Schedule not found')
      return (
        this.db.prepare('SELECT run_count FROM schedules WHERE id = ?').get(id) as {
          run_count: number
        }
      ).run_count
    })()
  }

  recordRun(input: RecordScheduleRunInput, now: number): ScheduleRun {
    const id = randomUUID()
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO schedule_runs
           (id, schedule_id, run_number, scheduled_for, started_at, outcome, trigger, late,
            reason, conversation_id, agent_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.scheduleId,
          input.runNumber ?? null,
          input.scheduledFor,
          input.startedAt ?? null,
          input.outcome,
          input.trigger,
          input.late ? 1 : 0,
          input.reason ?? null,
          input.conversationId ?? null,
          input.agentRunId ?? null,
          now
        )
      this.db
        .prepare(
          `DELETE FROM schedule_runs
           WHERE schedule_id = ? AND id NOT IN (
             SELECT id FROM schedule_runs WHERE schedule_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`
        )
        .run(input.scheduleId, input.scheduleId, RUN_HISTORY_LIMIT)
    })()
    return this.getRun(id)!
  }

  failRun(id: string, reason: string): ScheduleRun | undefined {
    this.db
      .prepare("UPDATE schedule_runs SET outcome = 'failed', reason = ? WHERE id = ?")
      .run(reason, id)
    return this.getRun(id)
  }

  getRun(id: string): ScheduleRun | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, a.phase AS agent_phase FROM schedule_runs r
         LEFT JOIN agent_runs a ON a.id = r.agent_run_id
         WHERE r.id = ?`
      )
      .get(id) as ScheduleRunRow | undefined
    return row ? toRun(row) : undefined
  }

  runs(scheduleId: string, limit = 50): ScheduleRun[] {
    return (
      this.db
        .prepare(
          `SELECT r.*, a.phase AS agent_phase FROM schedule_runs r
           LEFT JOIN agent_runs a ON a.id = r.agent_run_id
           WHERE r.schedule_id = ?
           ORDER BY r.created_at DESC, r.rowid DESC
           LIMIT ?`
        )
        .all(scheduleId, Math.max(1, Math.min(RUN_HISTORY_LIMIT, limit))) as ScheduleRunRow[]
    ).map(toRun)
  }

  /** The schedule run that started this agent run, if a schedule started it. */
  runForAgentRun(agentRunId: string): ScheduleRun | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, a.phase AS agent_phase FROM schedule_runs r
         LEFT JOIN agent_runs a ON a.id = r.agent_run_id
         WHERE r.agent_run_id = ?`
      )
      .get(agentRunId) as ScheduleRunRow | undefined
    return row ? toRun(row) : undefined
  }

  /** The most recent run that started a chat, which decides whether the next one may start. */
  latestStartedRun(scheduleId: string): ScheduleRun | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, a.phase AS agent_phase FROM schedule_runs r
         LEFT JOIN agent_runs a ON a.id = r.agent_run_id
         WHERE r.schedule_id = ? AND r.outcome = 'started'
         ORDER BY r.created_at DESC, r.rowid DESC
         LIMIT 1`
      )
      .get(scheduleId) as ScheduleRunRow | undefined
    return row ? toRun(row) : undefined
  }
}
