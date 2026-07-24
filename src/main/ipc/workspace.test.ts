import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import type { WorkspaceMutationAuthorization } from '../../shared/types'

type RegisteredHandler = (...args: unknown[]) => unknown

const { handlers, workspaceState, consume, trashItem } = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  workspaceState: { root: '' },
  consume: vi.fn(),
  trashItem: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler)
    })
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem
  }
}))

vi.mock('./state', () => ({
  appState: {
    workspaceWatcher: null,
    watchDebounceTimer: null,
    mainWindowRef: null
  },
  getStore: () => ({ get: vi.fn(), set: vi.fn() })
}))

vi.mock('./workspaceUtils', () => ({
  getStoredWorkspace: () => workspaceState.root,
  resolveKnownWorkspace: (passedRoot?: string) => passedRoot || workspaceState.root,
  assertInsideWorkspace: (target: string, root: string) => {
    const rel = relative(root, target)
    if (rel.startsWith('..')) throw new Error('Path escapes workspace')
  }
}))

vi.mock('../services/workspaceRules', () => ({
  loadWorkspaceRules: vi.fn(),
  beginWorkspaceInstructionScope: vi.fn(),
  resolveWorkspaceInstructionsForPath: vi.fn(),
  resetWorkspaceInstructionScope: vi.fn(),
  clearWorkspaceInstructionScope: vi.fn()
}))
vi.mock('../services/permissionBroker', () => ({ permissionBroker: { consume } }))

import { registerWorkspaceHandlers } from './workspace'

type TrashFileHandler = (
  event: unknown,
  passedRoot: string,
  filePath: string,
  authorization: WorkspaceMutationAuthorization
) => Promise<{ ok: boolean; error?: string }>

type ReadFileHandler = (
  event: unknown,
  passedRoot: string,
  filePath: string
) => Promise<{ ok: boolean; content: string | null; error?: string }>

describe('workspace file IPC', () => {
  beforeEach(async () => {
    handlers.clear()
    consume.mockReset()
    trashItem.mockReset()
    workspaceState.root = await mkdtemp(join(tmpdir(), 'sidekick-workspace-'))
    registerWorkspaceHandlers()
  })

  afterEach(async () => {
    await rm(workspaceState.root, { recursive: true, force: true })
  })

  it('moves a user-selected workspace file to the system trash', async () => {
    const filePath = 'notes/draft.md'
    const handler = handlers.get('workspace:trashFile') as TrashFileHandler

    const result = await handler({}, workspaceState.root, filePath, {
      requestedAccess: 'auto',
      authorizationToken: 'authorized'
    })

    expect(result).toEqual({ ok: true })
    expect(trashItem).toHaveBeenCalledWith(join(workspaceState.root, filePath))
    expect(consume).toHaveBeenCalledOnce()
  })

  it('uses the workspace supplied by the conversation instead of the visible workspace', async () => {
    const backgroundRoot = await mkdtemp(join(tmpdir(), 'sidekick-background-workspace-'))
    try {
      await writeFile(join(workspaceState.root, 'project.txt'), 'visible project', 'utf8')
      await writeFile(join(backgroundRoot, 'project.txt'), 'background project', 'utf8')

      const handler = handlers.get('workspace:readFile') as ReadFileHandler
      const result = await handler({}, backgroundRoot, 'project.txt')

      expect(result.ok).toBe(true)
      expect(result.content).toContain('background project')
      expect(result.content).not.toContain('visible project')
    } finally {
      await rm(backgroundRoot, { recursive: true, force: true })
    }
  })

  it('does not read through a symlink that escapes the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sidekick-outside-workspace-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside secret', 'utf8')
      await symlink(
        outside,
        join(workspaceState.root, 'outside-link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )

      const handler = handlers.get('workspace:readFile') as ReadFileHandler
      const result = await handler({}, workspaceState.root, 'outside-link/secret.txt')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('escapes the project root')
      expect(result.content).toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
