import { randomUUID } from 'crypto'
import type { AgentRunPhase } from '../../shared/agentRuntime'
import type { PinnedModel } from '../../shared/models'
import {
  ACTIVE_SCHEDULED_RUN_PHASES,
  nextScheduleOccurrence,
  SCHEDULE_MISSED_AFTER_MS,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type SchedulesChangedEvent
} from '../../shared/schedules'
import type { ScheduleStore } from './scheduleStore'

/** How the scheduler reaches the rest of the app. Each run goes through the canonical runtime. */
export interface ScheduledRunLauncher {
  /** An enabled model with this id, or null when it was removed or its provider disabled. */
  resolveModel: (modelId: string) => PinnedModel | null
  projectExists: (projectId: string) => boolean
  /** Creates the run's chat with the schedule's prompt as its first message. */
  createConversation: (schedule: Schedule, runNumber: number) => string
  /** Starts the agent run through `AgentRuntimeCoordinator`, under the user's permission mode. */
  start: (input: {
    conversationId: string
    agentRunId: string
    model: PinnedModel
  }) => Promise<void>
  /** Leaves an app-authored notice in the chat when its run could not start. */
  reportFailure: (conversationId: string, message: string) => void
}

export interface ScheduleServiceOptions {
  store: ScheduleStore
  launcher: ScheduledRunLauncher
  onChange: (change: SchedulesChangedEvent) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** Lets startup settle before missed runs catch up. */
  startDelayMs?: number
}

const ACTIVE_PHASES: ReadonlySet<AgentRunPhase> = new Set(ACTIVE_SCHEDULED_RUN_PHASES)

/** A long timer drifts across sleep, so the scheduler wakes at least this often to compare clocks. */
const MAX_TIMER_MS = 60_000
/** Bounds the count of missed occurrences after a very long absence. */
const MAX_COUNTED_MISSES = 10_000

function overlapReason(phase: AgentRunPhase): string {
  if (phase === 'awaiting_permission') {
    return 'Skipped: the previous run is still waiting for your approval.'
  }
  if (phase === 'awaiting_user')
    return 'Skipped: the previous run is still waiting for your answer.'
  return 'Skipped: the previous run is still working.'
}

/**
 * Starts schedules on time. It compares stored due times with the clock instead of trusting one
 * long timer, so sleep, clock changes and restarts cannot double or lose a run. Missed
 * occurrences collapse into one late run, or are skipped when the schedule does not catch up.
 */
export class ScheduleService {
  private readonly store: ScheduleStore
  private readonly launcher: ScheduledRunLauncher
  private readonly onChange: (change: SchedulesChangedEvent) => void
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly startDelayMs: number
  private timer: unknown = null
  private running = false
  private readonly launching = new Set<string>()
  private ticking: Promise<void> | null = null

  constructor(options: ScheduleServiceOptions) {
    this.store = options.store
    this.launcher = options.launcher
    this.onChange = options.onChange
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.startDelayMs = options.startDelayMs ?? 5_000
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.arm(this.startDelayMs)
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  /** Called when the computer wakes, so missed runs start without waiting for the timer. */
  wake(): void {
    if (this.running) void this.tick()
  }

  list(): Schedule[] {
    return this.store.list()
  }

  runs(id: string): ScheduleRun[] {
    return this.store.runs(id)
  }

  create(input: ScheduleInput): Schedule {
    const now = this.now()
    const schedule = this.store.create(input, nextScheduleOccurrence(input, now), now)
    this.changed()
    return schedule
  }

  update(id: string, input: ScheduleInput): Schedule {
    const current = this.require(id)
    const now = this.now()
    const schedule = this.store.update(
      id,
      input,
      current.enabled ? nextScheduleOccurrence(input, now) : null,
      now
    )
    this.changed()
    return schedule
  }

  pause(id: string): Schedule {
    this.require(id)
    const schedule = this.store.pause(id, this.now())
    this.changed()
    return schedule
  }

  resume(id: string): Schedule {
    const current = this.require(id)
    const now = this.now()
    const schedule = this.store.resume(id, nextScheduleOccurrence(current, now), now)
    this.changed()
    return schedule
  }

  delete(id: string): boolean {
    const deleted = this.store.delete(id)
    if (deleted) this.changed()
    return deleted
  }

  /** Starts a run now without moving the schedule's next time. Works while paused. */
  async runNow(id: string): Promise<ScheduleRun> {
    const schedule = this.require(id)
    return this.fire(schedule, { scheduledFor: this.now(), late: false, trigger: 'manual' })
  }

  /**
   * Called for each agent run phase change. When a scheduled run starts waiting for the user or
   * ends, the schedule's state changes with it; the renderer cannot reliably catch the first
   * phases itself, because they happen before it hears that the run exists.
   */
  agentRunChanged(agentRunId: string, ended: boolean): void {
    const run = this.store.runForAgentRun(agentRunId)
    if (!run) return
    this.changed(ended ? run.conversationId : undefined)
  }

  /** Starts every due schedule. Concurrent calls share one pass. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.runDue().finally(() => {
        this.ticking = null
        this.arm()
      })
    }
    return this.ticking
  }

  private async runDue(): Promise<void> {
    const now = this.now()
    const starts: Promise<unknown>[] = []
    for (const schedule of this.store.due(now)) {
      const dueAt = schedule.nextRunAt!
      const next = nextScheduleOccurrence(schedule, now)
      // Advance first: whatever happens to the run, this occurrence is handled once.
      if (!this.store.advance(schedule.id, dueAt, next)) continue
      if (now - dueAt <= SCHEDULE_MISSED_AFTER_MS) {
        starts.push(this.fire(schedule, { scheduledFor: dueAt, late: false, trigger: 'schedule' }))
        continue
      }
      const { count, latest } = this.missedOccurrences(schedule, dueAt, now)
      const earlier =
        count > 1 ? ` ${count - 1} earlier time${count > 2 ? 's were' : ' was'} skipped.` : ''
      if (!schedule.catchUp) {
        this.store.recordRun(
          {
            scheduleId: schedule.id,
            scheduledFor: latest,
            outcome: 'skipped',
            trigger: 'schedule',
            late: true,
            reason:
              count > 1
                ? `Skipped ${count} times while SideKick was closed or the computer was asleep.`
                : 'Skipped: SideKick was closed or the computer was asleep.'
          },
          now
        )
        this.changed()
        continue
      }
      starts.push(
        this.fire(schedule, {
          scheduledFor: latest,
          late: true,
          trigger: 'schedule',
          reason: `Started late: SideKick was closed or the computer was asleep.${earlier}`
        })
      )
    }
    await Promise.allSettled(starts)
  }

  private missedOccurrences(
    schedule: Schedule,
    firstDue: number,
    now: number
  ): { count: number; latest: number } {
    let latest = firstDue
    let count = 1
    for (; count < MAX_COUNTED_MISSES; count += 1) {
      const following = nextScheduleOccurrence(schedule, latest)
      if (following > now) break
      latest = following
    }
    return { count, latest }
  }

  private async fire(
    schedule: Schedule,
    occurrence: {
      scheduledFor: number
      late: boolean
      trigger: 'schedule' | 'manual'
      reason?: string
    }
  ): Promise<ScheduleRun> {
    const now = this.now()
    const base = {
      scheduleId: schedule.id,
      scheduledFor: occurrence.scheduledFor,
      trigger: occurrence.trigger,
      late: occurrence.late
    }
    const skip = (reason: string): ScheduleRun => {
      const run = this.store.recordRun({ ...base, outcome: 'skipped', reason }, now)
      this.changed()
      return run
    }
    // One chat at a time per schedule. Queuing behind an unanswered approval would only stack
    // up more waiting chats.
    if (this.launching.has(schedule.id)) return skip('Skipped: the previous run is still starting.')
    const previous = this.store.latestStartedRun(schedule.id)
    if (previous?.agentPhase && ACTIVE_PHASES.has(previous.agentPhase)) {
      return skip(overlapReason(previous.agentPhase))
    }

    const model = this.launcher.resolveModel(schedule.modelId)
    const missing = !model
      ? 'Paused: its model is no longer enabled. Choose another model, then resume.'
      : schedule.projectId && !this.launcher.projectExists(schedule.projectId)
        ? 'Paused: its project folder was removed. Choose another project, then resume.'
        : null
    if (missing || !model) {
      // Running anyway with a model or folder the user did not choose would be worse.
      const run = this.store.recordRun({ ...base, outcome: 'failed', reason: missing! }, now)
      if (schedule.enabled) this.store.pause(schedule.id, now, missing!)
      this.changed()
      return run
    }

    this.launching.add(schedule.id)
    try {
      const runNumber = this.store.claimRunNumber(schedule.id, now)
      const conversationId = this.launcher.createConversation(schedule, runNumber)
      const agentRunId = randomUUID()
      const run = this.store.recordRun(
        {
          ...base,
          outcome: 'started',
          runNumber,
          startedAt: now,
          conversationId,
          agentRunId,
          ...(occurrence.reason ? { reason: occurrence.reason } : {})
        },
        now
      )
      this.changed(conversationId)
      try {
        await this.launcher.start({ conversationId, agentRunId, model })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.launcher.reportFailure(conversationId, `The scheduled run could not start: ${message}`)
        const failed = this.store.failRun(run.id, `Could not start: ${message}`) ?? run
        this.changed(conversationId)
        return failed
      }
      // The agent run exists only now, so this is the change that shows it as active.
      this.changed(conversationId)
      return this.store.getRun(run.id) ?? run
    } finally {
      this.launching.delete(schedule.id)
    }
  }

  private require(id: string): Schedule {
    const schedule = this.store.get(id)
    if (!schedule) throw new Error('Schedule not found')
    return schedule
  }

  private changed(conversationId?: string): void {
    try {
      this.onChange({ schedules: this.store.list(), ...(conversationId ? { conversationId } : {}) })
    } catch (error) {
      console.warn('[Schedules] Could not publish a change:', error)
    }
    this.arm()
  }

  private arm(delayMs?: number): void {
    if (!this.running) return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    const earliest = this.store.earliestNextRunAt()
    if (earliest === null && delayMs === undefined) return
    const untilDue = earliest === null ? MAX_TIMER_MS : Math.max(0, earliest - this.now())
    const delay = Math.min(MAX_TIMER_MS, delayMs ?? untilDue)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }
}
