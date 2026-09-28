import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Project } from '../types/app.types'
import {
  buildCommandPaletteItems,
  latestProjectConversationId,
  type CommandPaletteActions,
  type CommandPaletteContext
} from './commandPaletteItems'

const conversation = (id: string, projectId: string | null, updatedAt: number): Conversation => ({
  id,
  title: `Title ${id}`,
  created_at: 1,
  updated_at: updatedAt,
  project_id: projectId,
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: null,
  home_project_name: null
})

const project: Project = {
  id: 'p',
  name: 'SideKick',
  folder_path: 'E:/code/sidekick',
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
}

function actions(): CommandPaletteActions {
  return {
    newChat: vi.fn(),
    newGroupChat: vi.fn(),
    openProject: vi.fn(),
    openSettings: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleBrowserPanel: vi.fn(),
    toggleVoice: vi.fn(),
    toggleTheme: vi.fn(),
    checkForUpdates: vi.fn(),
    previousConversation: vi.fn(),
    nextConversation: vi.fn(),
    openConversation: vi.fn(),
    openProjectConversations: vi.fn()
  }
}

function context(overrides: Partial<CommandPaletteContext> = {}): CommandPaletteContext {
  return {
    platform: 'windows',
    conversations: [conversation('a', 'p', 5), conversation('b', null, 9)],
    projects: [project],
    sidebarOrder: ['a', 'b'],
    currentConversationId: 'b',
    sidebarCollapsed: false,
    browserPanelOpen: false,
    voiceOn: false,
    theme: 'dark',
    actions: actions(),
    ...overrides
  }
}

describe('buildCommandPaletteItems', () => {
  it('shows each action with its shortcut from the shared table', () => {
    const items = buildCommandPaletteItems(context())
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('action:new-chat')?.shortcut).toBe('Ctrl+N')
    expect(byId.get('action:open-settings')?.shortcut).toBe('Ctrl+,')
    expect(byId.get('action:toggle-voice')).toMatchObject({
      title: 'Turn voice on',
      shortcut: 'Ctrl+Space'
    })
    expect(byId.get('action:next-conversation')?.shortcut).toBe('Ctrl+Shift+]')
    expect(byId.get('action:toggle-browser-panel')?.title).toBe('Show browser panel')
    expect(byId.get('action:toggle-sidebar')?.title).toBe('Hide sidebar')
  })

  it('uses macOS key names on macOS', () => {
    const items = buildCommandPaletteItems(context({ platform: 'macos' }))
    expect(items.find(({ id }) => id === 'action:new-chat')?.shortcut).toBe('⌘N')
    expect(items.find(({ id }) => id === 'conversation:a')?.shortcut).toBe('⌘1')
  })

  it('leaves out voice and the browser panel where they are unavailable', () => {
    const ids = buildCommandPaletteItems(context({ voiceOn: null, browserPanelOpen: null })).map(
      ({ id }) => id
    )
    expect(ids).not.toContain('action:toggle-voice')
    expect(ids).not.toContain('action:toggle-browser-panel')
  })

  it('lists conversations with their jump key, project, and recency, and opens them', () => {
    const shared = actions()
    const items = buildCommandPaletteItems(context({ actions: shared }))
    const first = items.find(({ id }) => id === 'conversation:a')!
    const current = items.find(({ id }) => id === 'conversation:b')!
    expect(first).toMatchObject({ title: 'Title a', detail: 'SideKick', shortcut: 'Ctrl+1' })
    expect(current).toMatchObject({ detail: 'Open now', shortcut: 'Ctrl+2', recency: 9 })
    first.run()
    expect(shared.openConversation).toHaveBeenCalledWith('a')
  })

  it('lists projects by name and folder', () => {
    const shared = actions()
    const item = buildCommandPaletteItems(context({ actions: shared })).find(
      ({ id }) => id === 'project:p'
    )!
    expect(item).toMatchObject({ title: 'SideKick', detail: 'E:/code/sidekick' })
    item.run()
    expect(shared.openProjectConversations).toHaveBeenCalledWith('p')
  })

  it('disables moving between conversations when there is only one', () => {
    const items = buildCommandPaletteItems(context({ sidebarOrder: ['a'] }))
    expect(items.find(({ id }) => id === 'action:next-conversation')?.disabled).toBe(true)
  })
})

describe('latestProjectConversationId', () => {
  it('picks the most recently updated chat in the project', () => {
    const conversations = [
      conversation('old', 'p', 1),
      conversation('new', 'p', 3),
      conversation('elsewhere', null, 9)
    ]
    expect(latestProjectConversationId(conversations, 'p')).toBe('new')
    expect(latestProjectConversationId(conversations, 'empty')).toBeNull()
  })
})
