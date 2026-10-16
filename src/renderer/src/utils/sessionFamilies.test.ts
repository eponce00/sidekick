import { describe, expect, it } from 'vitest'
import type { Conversation } from '../types/app.types'
import {
  dotFilterStatus,
  expandFamilies,
  familyRollUpLabel,
  indexSessionFamilies,
  mostUrgentDot,
  sidebarDot
} from './sessionFamilies'

function chat(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    created_at: 1,
    updated_at: 1,
    project_id: 'p1',
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: null,
    home_project_name: null,
    ...overrides
  }
}

const worker = (id: string, manager: string, created: number, project = 'p1'): Conversation =>
  chat(id, {
    created_at: created,
    project_id: project,
    started_by_kind: 'session',
    started_by_conversation_id: manager,
    session_handle: id
  })

describe('indexSessionFamilies', () => {
  it('nests workers under a listed manager in start order, whatever their project', () => {
    const index = indexSessionFamilies([
      chat('manager'),
      worker('b', 'manager', 3),
      worker('a', 'manager', 2, 'other-project'),
      chat('plain')
    ])
    expect(index.workersByManager.get('manager')?.map(({ id }) => id)).toEqual(['a', 'b'])
    expect([...index.nestedIds].sort()).toEqual(['a', 'b'])
  })

  it('leaves a worker on its own when its manager is not listed, and never nests a loop', () => {
    const index = indexSessionFamilies([
      worker('orphan', 'deleted-manager', 1),
      worker('x', 'y', 1),
      worker('y', 'x', 2)
    ])
    expect(index.nestedIds.size).toBe(0)
    expect(index.workersByManager.size).toBe(0)
  })
})

describe('marks and roll-up', () => {
  it('prefers a pending approval, then the session state, then what the renderer knows', () => {
    expect(sidebarDot('waiting', 'working')).toBe('waiting')
    expect(sidebarDot('working', 'failed')).toBe('failed')
    expect(sidebarDot(null, 'done')).toBe('unread')
    expect(sidebarDot('unread', 'idle')).toBe('unread')
    expect(sidebarDot(null)).toBeNull()
  })

  it('files each mark under the filter that names it', () => {
    expect(dotFilterStatus('failed')).toBe('waiting')
    expect(dotFilterStatus('queued')).toBe('working')
    expect(dotFilterStatus('unread')).toBe('unread')
    expect(dotFilterStatus('stopped')).toBeNull()
  })

  it('rolls a family up to its most urgent mark and a one-line count', () => {
    expect(mostUrgentDot(['unread', 'working', null, 'waiting'])).toBe('waiting')
    expect(mostUrgentDot([null, 'stopped'])).toBe('stopped')
    expect(mostUrgentDot([null])).toBeNull()
    expect(familyRollUpLabel(['working', 'unread', 'working', 'waiting', null])).toBe(
      '1 needs you · 2 working · 1 done'
    )
    expect(familyRollUpLabel([null])).toBe('')
  })
})

describe('expandFamilies', () => {
  const index = indexSessionFamilies([
    chat('m1'),
    worker('w1', 'm1', 1),
    worker('w2', 'm1', 2),
    chat('m2'),
    worker('w3', 'm2', 1)
  ])

  it('follows the visible nesting for keyboard moves', () => {
    expect(expandFamilies(['m1', 'm2'], index, () => false)).toEqual(['m1', 'w1', 'w2', 'm2', 'w3'])
    expect(expandFamilies(['m1', 'm2'], index, (id) => id === 'm1')).toEqual(['m1', 'm2', 'w3'])
  })

  it('keeps only the workers a filter matches', () => {
    expect(
      expandFamilies(
        ['m1', 'm2'],
        index,
        () => false,
        ({ id }) => id === 'w2'
      )
    ).toEqual(['m1', 'w2', 'm2'])
  })
})
