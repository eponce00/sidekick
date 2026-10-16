import { describe, expect, it } from 'vitest'
import type { Conversation } from '../types/app.types'
import { groupConversationsByRecency, matchesStatusFilter, storedSidebarView } from './sidebarView'

const chat = (id: string, updatedAt: Date, pinned = false): Conversation => ({
  id,
  title: id,
  created_at: 0,
  updated_at: updatedAt.getTime(),
  project_id: null,
  is_pinned: pinned ? 1 : 0,
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: null,
  home_project_name: null
})

describe('groupConversationsByRecency', () => {
  it('puts pinned chats first, then buckets the rest by calendar day, newest first', () => {
    const now = new Date(2026, 9, 16, 1, 0)
    const groups = groupConversationsByRecency(
      [
        chat('last-month', new Date(2026, 8, 20)),
        chat('late-yesterday', new Date(2026, 9, 15, 23, 30)),
        chat('pinned-old', new Date(2026, 0, 1), true),
        chat('this-morning', new Date(2026, 9, 16, 0, 30)),
        chat('five-days-ago', new Date(2026, 9, 11, 12)),
        chat('just-now', new Date(2026, 9, 16, 0, 59))
      ],
      now.getTime()
    )
    expect(
      groups.map(({ label, conversations }) => [label, conversations.map(({ id }) => id)])
    ).toEqual([
      ['Pinned', ['pinned-old']],
      ['Today', ['just-now', 'this-morning']],
      ['Yesterday', ['late-yesterday']],
      ['Previous 7 days', ['five-days-ago']],
      ['Older', ['last-month']]
    ])
  })

  it('leaves out empty buckets', () => {
    const now = new Date(2026, 9, 16, 12)
    expect(
      groupConversationsByRecency([chat('today', now)], now.getTime()).map(({ bucket }) => bucket)
    ).toEqual(['today'])
    expect(groupConversationsByRecency([], now.getTime())).toEqual([])
  })
})

describe('status filter', () => {
  it('matches a row only on the mark it shows', () => {
    expect(matchesStatusFilter(null, 'all')).toBe(true)
    expect(matchesStatusFilter('waiting', 'waiting')).toBe(true)
    expect(matchesStatusFilter('waiting', 'working')).toBe(false)
    expect(matchesStatusFilter(null, 'unread')).toBe(false)
  })

  it('falls back to the folder view for anything but a stored "recent"', () => {
    expect(storedSidebarView('recent')).toBe('recent')
    expect(storedSidebarView(null)).toBe('folders')
    expect(storedSidebarView('garbage')).toBe('folders')
  })
})
