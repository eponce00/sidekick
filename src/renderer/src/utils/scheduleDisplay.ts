import type { ScheduleRun } from '../../../shared/schedules'

export type ScheduleRunTone = 'success' | 'error' | 'warning' | 'working' | 'muted'

/** What became of one occurrence, in words and a tone for its mark. */
export function scheduleRunStatus(run: ScheduleRun): { label: string; tone: ScheduleRunTone } {
  if (run.outcome === 'skipped') return { label: 'Skipped', tone: 'muted' }
  if (run.outcome === 'failed') return { label: 'Did not start', tone: 'error' }
  switch (run.agentPhase) {
    case 'completed':
      return { label: 'Completed', tone: 'success' }
    case 'failed':
      return { label: 'Failed', tone: 'error' }
    case 'cancelled':
      return { label: 'Stopped', tone: 'muted' }
    case 'interrupted':
      return { label: 'Interrupted', tone: 'warning' }
    case 'awaiting_permission':
      return { label: 'Waiting for your approval', tone: 'warning' }
    case 'awaiting_user':
      return { label: 'Waiting for your answer', tone: 'warning' }
    case undefined:
      return run.conversationId
        ? { label: 'Starting', tone: 'working' }
        : { label: 'Chat deleted', tone: 'muted' }
    default:
      return { label: 'Working', tone: 'working' }
  }
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** "Today, 9:00 AM", "Tomorrow, 9:00 AM", "Yesterday, …", or "Mon, Oct 19, 9:00 AM". */
export function formatScheduleTime(timestamp: number, now = Date.now()): string {
  const clock = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  const days = Math.round((startOfDay(timestamp) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `Today, ${clock}`
  if (days === 1) return `Tomorrow, ${clock}`
  if (days === -1) return `Yesterday, ${clock}`
  const date = new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  return `${date}, ${clock}`
}
