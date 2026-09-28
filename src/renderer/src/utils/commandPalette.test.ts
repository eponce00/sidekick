import { describe, expect, it } from 'vitest'
import {
  filterCommandPalette,
  nextEnabledIndex,
  RECENT_CONVERSATION_LIMIT,
  scoreCommandPaletteItem,
  type CommandPaletteItem
} from './commandPalette'

const item = (
  id: string,
  group: CommandPaletteItem['group'],
  title: string,
  extra: Partial<CommandPaletteItem> = {}
): CommandPaletteItem => ({ id, group, title, run: () => undefined, ...extra })

describe('scoreCommandPaletteItem', () => {
  it('matches every word, by prefix, substring, or fuzzy subsequence', () => {
    const settings = item('settings', 'actions', 'Open settings', { keywords: 'preferences' })
    expect(scoreCommandPaletteItem(settings, 'sett')).not.toBeNull()
    expect(scoreCommandPaletteItem(settings, 'open sett')).not.toBeNull()
    expect(scoreCommandPaletteItem(settings, 'prefs')).toBeNull()
    expect(scoreCommandPaletteItem(settings, 'preferences')).not.toBeNull()
    expect(scoreCommandPaletteItem(settings, 'opstg')).not.toBeNull()
    expect(scoreCommandPaletteItem(settings, 'open zebra')).toBeNull()
  })

  it('ranks an exact title above a prefix, a prefix above a later word, and those above fuzzy', () => {
    const exact = scoreCommandPaletteItem(item('a', 'actions', 'New chat'), 'new chat')!
    const prefix = scoreCommandPaletteItem(item('b', 'actions', 'Newsletter plan'), 'new')!
    const word = scoreCommandPaletteItem(item('c', 'actions', 'Start new plan'), 'new')!
    const fuzzy = scoreCommandPaletteItem(item('d', 'actions', 'Now we wait'), 'new')!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(fuzzy)
  })

  it('ignores case and accents', () => {
    expect(
      scoreCommandPaletteItem(item('a', 'conversations', 'Café résumé'), 'CAFE resume')
    ).not.toBeNull()
  })
})

describe('filterCommandPalette', () => {
  const conversations = Array.from({ length: 12 }, (_, index) =>
    item(`chat-${index}`, 'conversations', `Chat ${index}`, { recency: index })
  )
  const items = [
    item('new-chat', 'actions', 'New chat'),
    item('settings', 'actions', 'Open settings'),
    ...conversations,
    item('project', 'projects', 'SideKick', { detail: 'E:/code/sidekick' })
  ]

  it('lists actions, recent conversations, then projects when the query is empty', () => {
    const sections = filterCommandPalette(items, '')
    expect(sections.map(({ label }) => label)).toEqual([
      'Actions',
      'Recent conversations',
      'Projects'
    ])
    expect(sections[1].items).toHaveLength(RECENT_CONVERSATION_LIMIT)
    expect(sections[1].items[0].id).toBe('chat-11')
  })

  it('searches every conversation and drops empty groups', () => {
    const sections = filterCommandPalette(items, 'chat 3')
    expect(sections.map(({ id }) => id)).toEqual(['conversations'])
    expect(sections[0].items[0].id).toBe('chat-3')
  })

  it('finds a project by its folder', () => {
    const sections = filterCommandPalette(items, 'code/side')
    expect(sections.map(({ id }) => id)).toEqual(['projects'])
  })
})

describe('nextEnabledIndex', () => {
  const rows = [
    item('a', 'actions', 'A'),
    item('b', 'actions', 'B', { disabled: true }),
    item('c', 'actions', 'C')
  ]

  it('skips disabled rows and wraps around', () => {
    expect(nextEnabledIndex(rows, 0, 1)).toBe(2)
    expect(nextEnabledIndex(rows, 2, 1)).toBe(0)
    expect(nextEnabledIndex(rows, 0, -1)).toBe(2)
    expect(nextEnabledIndex(rows, -1, 1)).toBe(0)
  })

  it('returns -1 when nothing can be chosen', () => {
    expect(nextEnabledIndex([rows[1]], 0, 1)).toBe(-1)
    expect(nextEnabledIndex([], -1, 1)).toBe(-1)
  })
})
