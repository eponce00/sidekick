import { describe, expect, it } from 'vitest'
import type { ScheduleRun } from '../../../shared/schedules'
import { formatScheduleTime, scheduleRunStatus } from './scheduleDisplay'
import { groupScheduledConversations } from './scheduledRunGroups'
import type { Conversation } from '../types/app.types'

const run = (overrides: Partial<ScheduleRun>): ScheduleRun => ({
  id: 'run',
  scheduleId: 'schedule',
  scheduledFor: 1,
  outcome: 'started',
  trigger: 'schedule',
  late: false,
  conversationId: 'chat',
  ...overrides
})

describe('scheduleRunStatus', () => {
  it('reads what became of each occurrence', () => {
    expect(scheduleRunStatus(run({ agentPhase: 'completed' })).tone).toBe('success')
    expect(scheduleRunStatus(run({ agentPhase: 'executing_tool' })).tone).toBe('working')
    expect(scheduleRunStatus(run({ outcome: 'failed' })).tone).toBe('error')
  })
})

describe('formatScheduleTime', () => {
  it('names nearby days', () => {
    const now = new Date(2026, 9, 16, 12).getTime()
    expect(formatScheduleTime(new Date(2026, 9, 16, 9).getTime(), now)).toMatch(/^Today, /)
    expect(formatScheduleTime(new Date(2026, 9, 17, 9).getTime(), now)).toMatch(/^Tomorrow, /)
    expect(formatScheduleTime(new Date(2026, 9, 15, 9).getTime(), now)).toMatch(/^Yesterday, /)
    expect(formatScheduleTime(new Date(2026, 9, 20, 9).getTime(), now)).not.toMatch(/^To/)
  })
})

describe('groupScheduledConversations', () => {
  const chat = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
    id,
    title: id,
    created_at: 1,
    updated_at: 1,
    project_id: null,
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: null,
    home_project_name: null,
    ...overrides
  })

  it('groups at the first run, keeps other chats in place, and leaves pinned runs alone', () => {
    const entries = groupScheduledConversations([
      chat('a'),
      chat('r1', { schedule_id: 's', schedule_run_number: 1, title: 'Check · Run 1' }),
      chat('b'),
      chat('r3', { schedule_id: 's', schedule_run_number: 3 }),
      chat('r2', { schedule_id: 's', schedule_run_number: 2, is_pinned: 1 })
    ])
    expect(
      entries.map((entry) =>
        entry.kind === 'conversation'
          ? entry.conversation.id
          : `${entry.group.label}:${entry.group.conversations.map(({ id }) => id).join(',')}`
      )
    ).toEqual(['a', 'Check:r3,r1', 'b', 'r2'])
  })
})
