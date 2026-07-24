import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'

const { state } = vi.hoisted(() => ({
  state: {
    storedRoot: '/workspaces/visible',
    knownRoots: new Set<string>()
  }
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/Applications/SideKick.app' }
}))

vi.mock('./state', () => ({
  getStore: () => ({ get: () => state.storedRoot }),
  getDb: () => ({
    prepare: () => ({
      get: (projectRoot: string, conversationRoot: string) =>
        state.knownRoots.has(projectRoot) || state.knownRoots.has(conversationRoot)
          ? { known: 1 }
          : undefined
    })
  })
}))

import { resolveKnownWorkspace } from './workspaceUtils'

describe('resolveKnownWorkspace', () => {
  beforeEach(() => {
    state.storedRoot = resolve('/workspaces/visible')
    state.knownRoots.clear()
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
})
