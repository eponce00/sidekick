import { describe, expect, it } from 'vitest'
import type { Conversation, Project } from '../types/app.types'
import { adjacentConversationId, sidebarConversationOrder } from './sidebarConversationOrder'

const conversation = (id: string, projectId: string | null): Conversation => ({
  id,
  title: id,
  created_at: 1,
  updated_at: 1,
  project_id: projectId,
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: null,
  home_project_name: null
})

const project = (id: string): Project => ({
  id,
  name: id,
  folder_path: `/${id}`,
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
})

describe('sidebarConversationOrder', () => {
  const conversations = [
    conversation('loose-1', null),
    conversation('beta-1', 'beta'),
    conversation('alpha-1', 'alpha'),
    conversation('loose-2', null),
    conversation('alpha-2', 'alpha'),
    conversation('orphan', 'removed-project')
  ]
  const projects = [project('alpha'), project('beta')]

  it('lists project chats in project order, then standalone chats', () => {
    expect(sidebarConversationOrder(conversations, projects)).toEqual([
      'alpha-1',
      'alpha-2',
      'beta-1',
      'loose-1',
      'loose-2'
    ])
  })

  it('skips chats inside a collapsed project', () => {
    expect(sidebarConversationOrder(conversations, projects, new Set(['alpha']))).toEqual([
      'beta-1',
      'loose-1',
      'loose-2'
    ])
  })
})

describe('adjacentConversationId', () => {
  const order = ['a', 'b', 'c']

  it('steps and wraps at both ends', () => {
    expect(adjacentConversationId(order, 'b', 1)).toBe('c')
    expect(adjacentConversationId(order, 'c', 1)).toBe('a')
    expect(adjacentConversationId(order, 'a', -1)).toBe('c')
  })

  it('starts from the top or bottom when nothing listed is showing', () => {
    expect(adjacentConversationId(order, null, 1)).toBe('a')
    expect(adjacentConversationId(order, 'elsewhere', -1)).toBe('c')
    expect(adjacentConversationId([], null, 1)).toBeNull()
  })
})
