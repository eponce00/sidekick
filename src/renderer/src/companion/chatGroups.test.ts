import { describe, expect, it } from 'vitest'
import type { CompanionChat } from '../../../shared/companion'
import { groupChats, searchChats } from './chatGroups'

function chat(id: string, title: string, projectName: string | null = null): CompanionChat {
  return {
    id,
    title,
    updatedAt: 0,
    pinned: false,
    projectName,
    activePhase: null,
    needsAnswer: false
  }
}

describe('groupChats', () => {
  it('puts chats under their projects and keeps the rest apart, in the order received', () => {
    const groups = groupChats([
      chat('a', 'Pinned', 'notes'),
      chat('b', 'Recent', 'sidekick'),
      chat('c', 'Standalone'),
      chat('d', 'Older', 'notes'),
      chat('e', 'Another standalone')
    ])
    expect(groups.projects.map(({ name, chats }) => [name, chats.map(({ id }) => id)])).toEqual([
      ['notes', ['a', 'd']],
      ['sidekick', ['b']]
    ])
    expect(groups.chats.map(({ id }) => id)).toEqual(['c', 'e'])
  })

  it('is empty for no chats', () => {
    expect(groupChats([])).toEqual({ projects: [], chats: [] })
  })
})

describe('searchChats', () => {
  const chats = [
    chat('a', 'Fix the flaky upload test', 'sidekick'),
    chat('b', 'Plan the Lisbon trip'),
    chat('c', 'Weekly report draft', 'notes')
  ]

  it('matches every word in the title or project, ignoring case', () => {
    expect(searchChats(chats, 'UPLOAD')).toEqual([chats[0]])
    expect(searchChats(chats, 'the  trip')).toEqual([chats[1]])
    expect(searchChats(chats, 'notes draft')).toEqual([chats[2]])
    expect(searchChats(chats, 'upload lisbon')).toEqual([])
  })

  it('keeps every chat for a blank query', () => {
    expect(searchChats(chats, '   ')).toEqual(chats)
  })
})
