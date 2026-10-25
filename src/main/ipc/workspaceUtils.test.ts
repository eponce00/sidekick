import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'

const { state } = vi.hoisted(() => ({
  state: {
    storedRoot: '/workspaces/visible',
    knownRoots: new Set<string>(),
    chatsWithoutProject: new Set<string>()
  }
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/Applications/SideKick.app' }
}))

vi.mock('./state', () => ({
  getStore: () => ({ get: () => state.storedRoot }),
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (projectRoot: string, conversationRoot: string) =>
        sql.includes('home_workspace_root IS NULL')
          ? state.chatsWithoutProject.has(projectRoot)
            ? { known: 1 }
            : undefined
          : state.knownRoots.has(projectRoot) || state.knownRoots.has(conversationRoot)
            ? { known: 1 }
            : undefined
    })
  })
}))

vi.mock('../services/chatFolders', async (original) => ({
  ...(await original<typeof import('../services/chatFolders')>()),
  ensureChatFolder: vi.fn()
}))

import { resolveKnownWorkspace } from './workspaceUtils'
import { configureChatFoldersRoot } from '../services/chatFolders'

describe('resolveKnownWorkspace', () => {
  beforeEach(() => {
    state.storedRoot = resolve('/workspaces/visible')
    state.knownRoots.clear()
    state.chatsWithoutProject.clear()
  })

  it('keeps the visible workspace valid', () => {
    expect(resolveKnownWorkspace('/workspaces/visible')).toBe(resolve('/workspaces/visible'))
  })

  it('allows a different registered project for a background conversation', () => {
    state.knownRoots.add(resolve('/workspaces/background'))

    expect(resolveKnownWorkspace('/workspaces/background')).toBe(resolve('/workspaces/background'))
  })

  it('rejects an arbitrary renderer-supplied path', () => {
    expect(() => resolveKnownWorkspace('/private/unrelated')).toThrow(
      'Workspace is not associated with a SideKick project chat'
    )
  })

  it('allows only the exact folder of an existing chat without a project', () => {
    const chats = resolve('/data/chat-folders')
    configureChatFoldersRoot(chats)
    state.chatsWithoutProject.add('chat-1')

    expect(resolveKnownWorkspace(resolve(chats, 'chat-1'))).toBe(resolve(chats, 'chat-1'))
    for (const path of [
      resolve(chats, 'chat-2'),
      resolve(chats, 'chat-1', 'nested'),
      resolve(chats, 'chat-1', '..', 'chat-2'),
      chats,
      resolve(chats, '..', 'chat-1')
    ]) {
      expect(() => resolveKnownWorkspace(path)).toThrow(
        'Workspace is not associated with a SideKick project chat'
      )
    }
  })
})
