import type { AgentRunPhase } from './agentRuntime'

export const SCHEDULE_CADENCES = ['hourly', 'daily', 'weekdays', 'weekly'] as const

export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number]

/** When a schedule runs, in the computer's local time. */
export interface ScheduleTiming {
  cadence: ScheduleCadence
  /** 0–23. Ignored for hourly schedules. */
  hour: number
  /** 0–59. */
  minute: number
  /** 0 (Sunday) – 6 (Saturday). Used only by weekly schedules. */
  weekday: number
}

export interface ScheduleInput extends ScheduleTiming {
  name: string
  prompt: string
  /** The project folder the run works in, or null for a standalone chat. */
  projectId: string | null
  /** An enabled model, resolved in the main process when the run starts. */
  modelId: string
  /** Run once when SideKick was closed or asleep at the scheduled time. */
  catchUp: boolean
}

export interface UpdateScheduleInput extends ScheduleInput {
  id: string
}

export interface Schedule extends ScheduleInput {
  id: string
  enabled: boolean
  /** Why the scheduler paused this schedule on its own, such as a model that was removed. */
  pausedReason?: string
  /** Null while paused. */
  nextRunAt: number | null
  lastRunAt?: number
  /** Runs this schedule started, which numbers its chats. */
  runCount: number
  /** The run still working or waiting for the user, if any. */
  activeRun?: { conversationId: string; agentRunId: string; phase: AgentRunPhase }
  createdAt: number
  updatedAt: number
}

/** Phases in which a run still holds its schedule's one chat at a time. */
export const ACTIVE_SCHEDULED_RUN_PHASES: readonly AgentRunPhase[] = [
  'queued',
  'streaming',
  'awaiting_permission',
  'awaiting_user',
  'executing_tool',
  'compacting',
  'stopping'
]

export const SCHEDULE_RUN_OUTCOMES = ['started', 'skipped', 'failed'] as const

export type ScheduleRunOutcome = (typeof SCHEDULE_RUN_OUTCOMES)[number]

export interface ScheduleRun {
  id: string
  scheduleId: string
  /** Set for runs that started a chat. */
  runNumber?: number
  /** The occurrence this run is for. Earlier than `startedAt` for a late run. */
  scheduledFor: number
  startedAt?: number
  outcome: ScheduleRunOutcome
  trigger: 'schedule' | 'manual'
  /** Started after its time because SideKick was closed or the computer slept. */
  late: boolean
  reason?: string
  conversationId?: string
  agentRunId?: string
  /** The agent run's current phase, while its chat exists. */
  agentPhase?: AgentRunPhase
}

export interface SchedulesChangedEvent {
  schedules: Schedule[]
  /** A chat a scheduled run just created, so the conversation list can refresh. */
  conversationId?: string
}

export interface SchedulesAPI {
  list: () => Promise<Schedule[]>
  create: (input: ScheduleInput) => Promise<Schedule>
  update: (input: UpdateScheduleInput) => Promise<Schedule>
  pause: (id: string) => Promise<Schedule>
  resume: (id: string) => Promise<Schedule>
  delete: (id: string) => Promise<{ success: boolean }>
  /** Starts a run now. The result says why when none started. */
  runNow: (id: string) => Promise<ScheduleRun>
  runs: (id: string) => Promise<ScheduleRun[]>
  onChanged: (callback: (change: SchedulesChangedEvent) => void) => () => void
}

export const SCHEDULE_NAME_MAX_LENGTH = 120
export const SCHEDULE_PROMPT_MAX_LENGTH = 20_000

/**
 * A due time further in the past than this was missed: SideKick was closed or the computer
 * slept. A shorter delay is ordinary timer lateness and runs as scheduled.
 */
export const SCHEDULE_MISSED_AFTER_MS = 2 * 60_000

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

export function scheduleWeekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? WEEKDAY_NAMES[1]
}

function runsOnDay(timing: ScheduleTiming, day: number): boolean {
  if (timing.cadence === 'weekdays') return day >= 1 && day <= 5
  if (timing.cadence === 'weekly') return day === timing.weekday
  return true
}

/**
 * The first matching local minute strictly after `after`. Built from local date parts, so a
 * daily run stays at its wall-clock time across daylight-saving changes. A time skipped by a
 * spring-forward change runs at the shifted time JavaScript gives it; a time repeated by a
 * fall-back change runs once.
 */
export function nextScheduleOccurrence(timing: ScheduleTiming, after: number): number {
  const from = new Date(after)
  if (timing.cadence === 'hourly') {
    for (let hour = 0; hour <= 49; hour += 1) {
      const candidate = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
        from.getHours() + hour,
        timing.minute
      ).getTime()
      if (candidate > after) return candidate
    }
  } else {
    for (let day = 0; day <= 8; day += 1) {
      const candidate = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + day,
        timing.hour,
        timing.minute
      )
      if (candidate.getTime() > after && runsOnDay(timing, candidate.getDay())) {
        return candidate.getTime()
      }
    }
  }
  throw new Error('Could not compute the next scheduled time')
}

export function formatScheduleClock(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** "Every hour at :15", "Daily at 9:00 AM", "Weekdays at 9:00 AM", "Mondays at 9:00 AM". */
export function describeScheduleTiming(timing: ScheduleTiming): string {
  if (timing.cadence === 'hourly') {
    return `Every hour at :${String(timing.minute).padStart(2, '0')}`
  }
  const clock = formatScheduleClock(timing.hour, timing.minute)
  if (timing.cadence === 'daily') return `Daily at ${clock}`
  if (timing.cadence === 'weekdays') return `Weekdays at ${clock}`
  return `${scheduleWeekdayName(timing.weekday)}s at ${clock}`
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** Validates untrusted input from the renderer. Throws a message the form can show. */
export function validateScheduleInput(raw: unknown): ScheduleInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid schedule')
  const value = raw as Record<string, unknown>
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  if (!name) throw new Error('Give the schedule a name.')
  if (name.length > SCHEDULE_NAME_MAX_LENGTH) throw new Error('The name is too long.')
  if (!prompt) throw new Error('Write the prompt the schedule sends.')
  if (prompt.length > SCHEDULE_PROMPT_MAX_LENGTH) throw new Error('The prompt is too long.')
  if (!SCHEDULE_CADENCES.includes(value.cadence as ScheduleCadence)) {
    throw new Error('Choose how often the schedule runs.')
  }
  if (!integerIn(value.hour, 0, 23) || !integerIn(value.minute, 0, 59)) {
    throw new Error('Choose a valid time.')
  }
  if (!integerIn(value.weekday, 0, 6)) throw new Error('Choose a valid day.')
  if (typeof value.modelId !== 'string' || !value.modelId || value.modelId.length > 500) {
    throw new Error('Choose a model.')
  }
  const projectId = value.projectId
  if (
    projectId !== null &&
    (typeof projectId !== 'string' || !projectId || projectId.length > 200)
  ) {
    throw new Error('Choose a project folder.')
  }
  return {
    name,
    prompt,
    projectId,
    modelId: value.modelId,
    cadence: value.cadence as ScheduleCadence,
    hour: value.hour,
    minute: value.minute,
    weekday: value.weekday,
    catchUp: value.catchUp !== false
  }
}
