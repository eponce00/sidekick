import { randomUUID } from 'crypto'
import type { AgentRunPhase } from '../../shared/agentRuntime'
import type { PinnedModel } from '../../shared/models'
import {
  PERMISSION_MODE_LABELS,
  permissionModeWithin,
  type PermissionMode
} from '../../shared/permissions'
import {
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
  /**
   * Where the run works. Its project folder when no other agent is writing there; otherwise a
   * new worktree for a Git project, or a skip with the reason. Without it, the project folder.
   */
  placeRun?: (schedule: Schedule) => Promise<ScheduledRunPlacement>
  /**
   * Creates the run's chat, in `projectId` and working in `worktreeId` when given, with the
   * schedule's prompt as its first message.
   */
  createConversation: (
    schedule: Schedule,
    runNumber: number,
    projectId: string | null,
    worktreeId?: string | null
  ) => string
  /** The run was started but waits for a free run slot, so it has no phase yet. */
  isRunQueued?: (agentRunId: string) => boolean
  /** Starts the agent run through `AgentRuntimeCoordinator`, under the user's permission mode. */
  start: (input: {
    conversationId: string
    agentRunId: string
    model: PinnedModel
  }) => Promise<void>
  /** Leaves an app-authored notice in the chat when its run could not start. */
  reportFailure: (conversationId: string, message: string) => void
}

export type ScheduledRunPlacement =
  | {
      projectId: string | null
      /** The run's own worktree of the project, when the project folder was busy. */
      worktreeId?: string
      /** Said in the run's history, as when it moved to a new worktree. */
      note?: string
      /** Undoes the placement when the run's chat could not be created. */
      discard?: () => Promise<void>
    }
  | { skip: string }

export interface ScheduleServiceOptions {
  store: ScheduleStore
  launcher: ScheduledRunLauncher
  onChange: (change: SchedulesChangedEvent) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** Lets startup settle before missed runs catch up. */
  startDelayMs?: number
  /** The user's permission setting, which a schedule's ceiling may narrow but never widen. */
  permissionMode?: () => PermissionMode
  /**
   * A scheduled chat finished with nothing left running in its family. No manager chat is
   * watching it, so the user hears about it.
   */
  onFinished?: (notice: ScheduledRunFinishedNotice) => void
}

export interface ScheduledRunFinishedNotice {
  scheduleId: string
  conversationId: string
  title: string
  reply: string
}

/** A long timer drifts across sleep, so the scheduler wakes at least this often to compare clocks. */
const MAX_TIMER_MS = 60_000
/** Bounds the count of missed occurrences after a very long absence. */
const MAX_COUNTED_MISSES = 10_000

function overlapReason(phase: AgentRunPhase, worker: boolean): string {
  const who = worker ? 'a chat the previous run started' : 'the previous run'
  if (phase === 'awaiting_permission') return `Skipped: ${who} is still waiting for your approval.`
  if (phase === 'awaiting_user') return `Skipped: ${who} is still waiting for your answer.`
  return `Skipped: ${who} is still working.`
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
  private readonly permissionMode?: () => PermissionMode
  private readonly onFinished?: (notice: ScheduledRunFinishedNotice) => void
  private timer: unknown = null
  private running = false
  private readonly launching = new Set<string>()
  private ticking: Promise<void> | null = null
  /** Runs already announced as finished, so a repeated event says it once. */
  private readonly notified = new Set<string>()

  constructor(options: ScheduleServiceOptions) {
    this.store = options.store
    this.launcher = options.launcher
    this.onChange = options.onChange
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.startDelayMs = options.startDelayMs ?? 5_000
    this.permissionMode = options.permissionMode
    this.onFinished = options.onFinished
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

  /**
   * The ceiling a saved schedule keeps: the one asked for, or the setting's mode. It may not be
   * looser than the setting when it is chosen; a ceiling saved earlier stays as it was.
   */
  private ceiling(input: ScheduleInput, current?: Schedule): PermissionMode | null {
    const setting = this.permissionMode?.()
    const requested = input.permissionCeiling ?? (current ? current.permissionCeiling : setting)
    if (!requested || !setting) return requested ?? null
    if (requested !== current?.permissionCeiling && !permissionModeWithin(requested, setting)) {
      throw new Error(
        `A schedule cannot allow more than your permission setting, ${PERMISSION_MODE_LABELS[setting]}. Choose a stricter level, or change the setting first.`
      )
    }
    return requested
  }

  create(input: ScheduleInput): Schedule {
    const now = this.now()
    const schedule = this.store.create(
      { ...input, permissionCeiling: this.ceiling(input) },
      nextScheduleOccurrence(input, now),
      now
    )
    this.changed()
    return schedule
  }

  update(id: string, input: ScheduleInput): Schedule {
    const current = this.require(id)
    const now = this.now()
    const schedule = this.store.update(
      id,
      { ...input, permissionCeiling: this.ceiling(input, current) },
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
    const found = this.store.runForAgentRun(agentRunId)
    if (!found) return
    this.changed(ended ? found.conversationId : undefined)
  }

  /**
   * Called once a run's reply is saved. When a scheduled chat finishes and none of the chats it
   * started is still going, the user is told; until then its workers' reports wake it again.
   */
  agentRunFinalized(agentRunId: string): void {
    if (this.notified.has(agentRunId)) return
    const found = this.store.runForAgentRun(agentRunId)
    if (!found?.root || !found.run.conversationId) return
    const reply = this.store.reply(agentRunId)
    if (reply?.phase !== 'completed') return
    if (this.store.activeFamilyMember(found.run.conversationId)) return
    const schedule = this.store.get(found.run.scheduleId)
    if (!schedule) return
    this.notified.add(agentRunId)
    const workers = found.run.workers?.length ?? 0
    try {
      this.onFinished?.({
        scheduleId: schedule.id,
        conversationId: found.run.conversationId,
        title: `${schedule.name} · Run ${found.run.runNumber ?? ''}`.trim(),
        reply:
          reply.content.trim() ||
          (workers
            ? `Finished with ${workers} chat${workers === 1 ? '' : 's'} it started.`
            : 'Finished.')
      })
    } catch (error) {
      console.warn('[Schedules] Could not announce a finished run:', error)
    }
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
    // The previous run's family counts as one run: the chats it started may still be working.
    const previous = this.store.latestStartedRun(schedule.id)
    const active = previous?.conversationId
      ? this.store.activeFamilyMember(previous.conversationId)
      : null
    if (active) return skip(overlapReason(active.phase, active.worker))
    if (previous?.agentRunId && this.launcher.isRunQueued?.(previous.agentRunId)) {
      return skip('Skipped: the previous run is still waiting for a free run slot.')
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
      const placement = this.launcher.placeRun
        ? await this.launcher.placeRun(schedule)
        : { projectId: schedule.projectId }
      if ('skip' in placement) return skip(placement.skip)
      const runNumber = this.store.claimRunNumber(schedule.id, now)
      let conversationId: string
      try {
        conversationId = this.launcher.createConversation(
          schedule,
          runNumber,
          placement.projectId,
          placement.worktreeId ?? null
        )
      } catch (error) {
        await placement.discard?.().catch(() => undefined)
        throw error
      }
      const agentRunId = randomUUID()
      const reason = [occurrence.reason, placement.note].filter(Boolean).join(' ')
      const run = this.store.recordRun(
        {
          ...base,
          outcome: 'started',
          runNumber,
          startedAt: now,
          conversationId,
          agentRunId,
          ...(reason ? { reason } : {})
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
