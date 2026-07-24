import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  CONVERSATION_GOAL_MAX_LENGTH,
  type ConversationGoal,
  type ConversationGoalStatus,
  type CreateConversationGoalInput,
  type UpdateConversationGoalInput
} from '../../shared/conversationGoals'
import type { TodoItem } from '../../shared/types'

interface GoalRow {
  id: string
  conversation_id: string
  objective: string
  status: ConversationGoalStatus
  revision: number
  continuation_count: number
  prompt_tokens: number
  completion_tokens: number
  blocked_streak: number
  blocked_key: string | null
  plan_json: string
  completion_summary: string | null
  completion_verification: string | null
  status_reason: string | null
  current_run_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

function parsePlan(value: string): TodoItem[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : []
  } catch {
    return []
  }
}

function mapGoal(row: GoalRow): ConversationGoal {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    objective: row.objective,
    status: row.status,
    revision: row.revision,
    continuationCount: row.continuation_count,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    blockedStreak: row.blocked_streak,
    plan: parsePlan(row.plan_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.blocked_key ? { blockedKey: row.blocked_key } : {}),
    ...(row.completion_summary ? { completionSummary: row.completion_summary } : {}),
    ...(row.completion_verification ? { completionVerification: row.completion_verification } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(row.current_run_id ? { currentRunId: row.current_run_id } : {}),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  }
}

function objective(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('A goal needs a concrete objective')
  if (normalized.length > CONVERSATION_GOAL_MAX_LENGTH) {
    throw new Error(
      `Goals can be at most ${CONVERSATION_GOAL_MAX_LENGTH.toLocaleString()} characters`
    )
  }
  return normalized
}

function blockerKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500)
}

export class ConversationGoalStore {
  constructor(
    private readonly db: Database.Database,
    private readonly publish: (goal: ConversationGoal) => void = () => undefined
  ) {}

  get(id: string): ConversationGoal | null {
    const row = this.db.prepare('SELECT * FROM conversation_goals WHERE id = ?').get(id) as
      | GoalRow
      | undefined
    return row ? mapGoal(row) : null
  }

  current(conversationId: string): ConversationGoal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_goals
         WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(conversationId) as GoalRow | undefined
    return row && row.status !== 'cleared' ? mapGoal(row) : null
  }

  runnable(conversationId: string): ConversationGoal | null {
    const goal = this.current(conversationId)
    return goal?.status === 'active' ? goal : null
  }

  create(input: CreateConversationGoalInput): ConversationGoal {
    const existing = this.current(input.conversationId)
    if (existing && ['active', 'paused', 'blocked'].includes(existing.status)) {
      throw new Error('This conversation already has an unfinished goal. Resume or clear it first.')
    }
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO conversation_goals
         (id, conversation_id, objective, status, revision, continuation_count,
          blocked_streak, plan_json, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, 0, 0, '[]', ?, ?)`
      )
      .run(id, input.conversationId, objective(input.objective), now, now)
    return this.changed(id, 'created')
  }

  edit(input: UpdateConversationGoalInput): ConversationGoal {
    const goal = this.require(input.goalId)
    if (goal.status === 'completed' || goal.status === 'cleared') {
      throw new Error('Finished goals cannot be edited')
    }
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET objective = ?, revision = revision + 1, blocked_streak = 0,
             blocked_key = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(objective(input.objective), Date.now(), goal.id)
    return this.changed(goal.id, 'edited')
  }

  pause(id: string, reason = 'Paused by user'): ConversationGoal {
    const goal = this.require(id)
    if (goal.status === 'completed' || goal.status === 'cleared') return goal
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET status = 'paused', status_reason = ?, current_run_id = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(reason, Date.now(), id)
    return this.changed(id, 'paused')
  }

  resume(id: string): ConversationGoal {
    const goal = this.require(id)
    if (goal.status === 'completed' || goal.status === 'cleared') {
      throw new Error('This goal is already finished')
    }
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET status = 'active', status_reason = NULL, blocked_streak = 0,
             blocked_key = NULL, current_run_id = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), id)
    return this.changed(id, 'resumed')
  }

  clear(id: string): ConversationGoal {
    this.require(id)
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET status = 'cleared', status_reason = 'Cleared by user',
             current_run_id = NULL, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), id)
    return this.changed(id, 'cleared')
  }

  bindRun(id: string, runId: string): ConversationGoal {
    const goal = this.require(id)
    if (goal.status !== 'active') throw new Error('Only an active goal can start a run')
    this.db
      .prepare('UPDATE conversation_goals SET current_run_id = ?, updated_at = ? WHERE id = ?')
      .run(runId, Date.now(), id)
    return this.changed(id, 'run_started')
  }

  releaseRun(id: string, runId: string): ConversationGoal {
    this.db
      .prepare(
        `UPDATE conversation_goals SET current_run_id = NULL, updated_at = ?
         WHERE id = ? AND current_run_id = ?`
      )
      .run(Date.now(), id, runId)
    return this.changed(id, 'run_finished')
  }

  continue(id: string): ConversationGoal {
    const goal = this.require(id)
    if (goal.status !== 'active') return goal
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET continuation_count = continuation_count + 1, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), id)
    return this.changed(id, 'continued')
  }

  addUsage(id: string, promptTokens: number, completionTokens: number): ConversationGoal {
    this.require(id)
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
             updated_at = ? WHERE id = ?`
      )
      .run(
        Math.max(0, Math.trunc(promptTokens || 0)),
        Math.max(0, Math.trunc(completionTokens || 0)),
        Date.now(),
        id
      )
    return this.changed(id, 'usage_updated')
  }

  updatePlan(id: string, plan: TodoItem[]): ConversationGoal {
    this.require(id)
    this.db
      .prepare('UPDATE conversation_goals SET plan_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(plan), Date.now(), id)
    return this.changed(id, 'plan_updated')
  }

  complete(id: string, summary: string, verification: string): ConversationGoal {
    const goal = this.require(id)
    if (goal.status !== 'active') throw new Error('Only an active goal can be completed')
    const remaining = goal.plan.filter((item) => item.status !== 'completed')
    if (remaining.length) {
      throw new Error(
        `The goal plan still has ${remaining.length} unfinished item${remaining.length === 1 ? '' : 's'}. Finish or revise the plan before completing the goal.`
      )
    }
    if (!summary.trim() || !verification.trim()) {
      throw new Error('Goal completion requires both a result summary and concrete verification')
    }
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET status = 'completed', completion_summary = ?, completion_verification = ?,
             status_reason = NULL, blocked_streak = 0, blocked_key = NULL,
             current_run_id = NULL, completed_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(summary.trim(), verification.trim(), now, now, id)
    return this.changed(id, 'completed')
  }

  reportBlocked(id: string, rawKey: string, reason: string): ConversationGoal {
    const goal = this.require(id)
    if (goal.status !== 'active') throw new Error('Only an active goal can report a blocker')
    const key = blockerKey(rawKey || reason)
    if (!key || !reason.trim()) throw new Error('A blocker needs a stable key and explanation')
    const streak = goal.blockedKey === key ? goal.blockedStreak + 1 : 1
    const status: ConversationGoalStatus = streak >= 3 ? 'blocked' : 'active'
    this.db
      .prepare(
        `UPDATE conversation_goals
         SET status = ?, blocked_key = ?, blocked_streak = ?, status_reason = ?,
             current_run_id = CASE WHEN ? = 'blocked' THEN NULL ELSE current_run_id END,
             updated_at = ? WHERE id = ?`
      )
      .run(status, key, streak, reason.trim(), status, Date.now(), id)
    return this.changed(id, status === 'blocked' ? 'blocked' : 'blocker_reported')
  }

  pauseActiveAfterRestart(): ConversationGoal[] {
    const ids = this.db
      .prepare("SELECT id FROM conversation_goals WHERE status = 'active'")
      .all() as Array<{ id: string }>
    return ids.map(({ id }) => this.pause(id, 'SideKick restarted before the goal finished'))
  }

  private require(id: string): ConversationGoal {
    const goal = this.get(id)
    if (!goal) throw new Error('Goal not found')
    return goal
  }

  private changed(id: string, type: string): ConversationGoal {
    const goal = this.require(id)
    this.db
      .prepare(
        `INSERT INTO conversation_goal_events
         (id, goal_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), id, type, JSON.stringify(goal), Date.now())
    this.publish(goal)
    return goal
  }
}
