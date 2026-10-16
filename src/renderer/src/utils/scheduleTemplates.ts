import type { ScheduleTiming } from '../../../shared/schedules'

export interface ScheduleTemplate extends ScheduleTiming {
  id: string
  name: string
  description: string
  prompt: string
}

/**
 * Starting points for the schedule form. Each asks for a report rather than changes, because a
 * scheduled run usually works while no one is watching.
 */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: 'morning-summary',
    name: 'Morning change summary',
    description: 'What changed in the project since yesterday',
    cadence: 'weekdays',
    hour: 9,
    minute: 0,
    weekday: 1,
    prompt:
      'Summarize the commits and file changes in this project from the last day. List what ' +
      'changed, anything that looks risky, and open questions. Keep it short. If nothing ' +
      'changed, say so in one line. Do not change any files.'
  },
  {
    id: 'bug-review',
    name: 'Review for bugs',
    description: 'Look over recent changes for likely defects',
    cadence: 'daily',
    hour: 17,
    minute: 0,
    weekday: 1,
    prompt:
      'Review the changes in this project from the last day for likely bugs. For each one, say ' +
      'where it is, what goes wrong, and how you would fix it. Report only problems you are ' +
      'confident about. Do not change any files.'
  },
  {
    id: 'dependency-check',
    name: 'Dependency check',
    description: 'Outdated packages and security advisories',
    cadence: 'weekly',
    hour: 8,
    minute: 0,
    weekday: 1,
    prompt:
      "Use this project's own package tools to check its dependencies for available updates " +
      'and known security advisories. Report what should be updated, in order of importance, ' +
      'and why. Do not change any files.'
  },
  {
    id: 'docs-drift',
    name: 'Documentation drift',
    description: 'Docs that no longer match the code',
    cadence: 'weekly',
    hour: 15,
    minute: 0,
    weekday: 5,
    prompt:
      "Compare this project's documentation with its code. List each statement that is out of " +
      'date, with the file and the correction it needs. Do not change any files.'
  }
]
