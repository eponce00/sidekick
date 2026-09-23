import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import type { WorkspaceMutationAuthorization } from '../../shared/types'

type RegisteredHandler = (...args: unknown[]) => unknown

const {
  handlers,
  workspaceState,
  consume,
  trashItem,
  openPath,
  showItemInFolder,
  clipboardWriteText,
  menuPopup,
  menuTemplates,
  showOpenDialog,
  showMessageBox
} = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  workspaceState: { root: '' },
  consume: vi.fn(),
  trashItem: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  clipboardWriteText: vi.fn(),
  menuPopup: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  menuTemplates: [] as Array<
    Array<{
      label?: string
      click?: () => void
      submenu?: Array<{ label?: string; click?: () => void }>
    }>
  >
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn((template) => {
      menuTemplates.push(template)
      return { popup: menuPopup }
    })
  },
  clipboard: { writeText: clipboardWriteText },
  dialog: { showOpenDialog, showMessageBox },
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler)
    })
  },
  shell: {
    openPath,
    showItemInFolder,
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

const watchMock = vi.hoisted(() => vi.fn())
// Only `watch` is faked; the rest of fs stays real so the file-IPC tests above
// keep operating on their temporary directories.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, watch: watchMock }
})

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
vi.mock('../services/externalOpeners', () => ({
  discoverExternalOpeners: vi.fn().mockResolvedValue([
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'editor',
      executable: 'Code.exe',
      args: (target: string) => [target]
    }
  ])
}))

import { registerWorkspaceHandlers, startWorkspaceWatcher } from './workspace'
import { appState } from './state'

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
    openPath.mockReset().mockResolvedValue('')
    showItemInFolder.mockReset()
    clipboardWriteText.mockReset()
    menuPopup.mockReset()
    showOpenDialog.mockReset()
    showMessageBox.mockReset()
    menuTemplates.length = 0
    workspaceState.root = await mkdtemp(join(tmpdir(), 'sidekick-workspace-'))
    registerWorkspaceHandlers()
  })

  afterEach(async () => {
    await rm(workspaceState.root, { recursive: true, force: true })
  })

  it('returns typed project-relative references from the attachment picker', async () => {
    await mkdir(join(workspaceState.root, 'src'))
    await writeFile(join(workspaceState.root, 'src', 'main.ts'), 'export {}', 'utf8')
    showMessageBox.mockResolvedValue({ response: 0 })
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [join(workspaceState.root, 'src', 'main.ts')]
    })

    const handler = handlers.get('workspace:selectContextAttachments') as RegisteredHandler
    const result = (await handler({ sender: {} }, workspaceState.root)) as {
      ok: boolean
      attachments: Array<{ kind: string; relativePath: string }>
    }

    expect(result.ok).toBe(true)
    expect(result.attachments).toMatchObject([{ kind: 'file', relativePath: 'src/main.ts' }])
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

  it('shows secure native actions for a workspace file', async () => {
    const handler = handlers.get('workspace:showPathMenu') as RegisteredHandler
    await handler({ sender: {} }, 'notes/draft.md', workspaceState.root, false)

    const template = menuTemplates[0]
    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      'Open in VS Code',
      'Open with',
      process.platform === 'win32' ? 'Show in File Explorer' : 'Show in Folder',
      'Copy Full Path',
      'Copy Project-Relative Path'
    ])
    expect(
      template
        .find((item) => item.label === 'Open with')
        ?.submenu?.map((item) => item.label)
        .filter(Boolean)
    ).toEqual([
      'VS Code',
      'Default app',
      ...(process.platform === 'win32' ? ['Choose another app…'] : []),
      process.platform === 'win32' ? 'Show in File Explorer' : 'Show in Folder'
    ])
    template.find((item) => item.label === 'Copy Project-Relative Path')?.click?.()
    expect(clipboardWriteText).toHaveBeenCalledWith('notes/draft.md')
    expect(menuPopup).toHaveBeenCalledOnce()
  })

  it('opens a unique nested file when a message only references its basename', async () => {
    await mkdir(join(workspaceState.root, 'src', 'components'), { recursive: true })
    const target = join(workspaceState.root, 'src', 'components', 'lightbox.js')
    await writeFile(target, 'export {}', 'utf8')
    const handler = handlers.get('workspace:openFileReference') as RegisteredHandler

    const result = await handler({ sender: {} }, 'lightbox.js', workspaceState.root)

    expect(result).toMatchObject({ ok: true, status: 'opened', path: target })
    expect(openPath).toHaveBeenCalledWith(target)
  })

  it('shows a path chooser when a basename matches multiple workspace files', async () => {
    await mkdir(join(workspaceState.root, 'app'), { recursive: true })
    await mkdir(join(workspaceState.root, 'demo'), { recursive: true })
    await writeFile(join(workspaceState.root, 'app', 'main.js'), 'app', 'utf8')
    await writeFile(join(workspaceState.root, 'demo', 'main.js'), 'demo', 'utf8')
    const handler = handlers.get('workspace:openFileReference') as RegisteredHandler

    const result = await handler({ sender: {} }, 'main.js', workspaceState.root)

    expect(result).toMatchObject({ ok: true, status: 'choose' })
    expect(menuTemplates.at(-1)?.map((item) => item.label)).toEqual(['app/main.js', 'demo/main.js'])
    expect(menuPopup).toHaveBeenCalledOnce()
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('workspace:resolveFileReference', () => {
  beforeEach(async () => {
    handlers.clear()
    workspaceState.root = await mkdtemp(join(tmpdir(), 'sidekick-resolve-'))
    await mkdir(join(workspaceState.root, 'src', 'components'), { recursive: true })
    await writeFile(join(workspaceState.root, 'src', 'components', 'ChatPanel.tsx'), '', 'utf8')
    await writeFile(join(workspaceState.root, 'README.md'), '', 'utf8')
    registerWorkspaceHandlers()
  })

  afterEach(async () => {
    await rm(workspaceState.root, { recursive: true, force: true })
  })

  it('resolves a project-relative path directly', async () => {
    const resolve = handlers.get('workspace:resolveFileReference') as RegisteredHandler
    const result = (await resolve({}, './src/components/ChatPanel.tsx', workspaceState.root)) as {
      ok: boolean
      matches: string[]
    }
    expect(result).toEqual({ ok: true, matches: ['src/components/ChatPanel.tsx'] })
  })

  it('finds a bare file name anywhere in the tree', async () => {
    const resolve = handlers.get('workspace:resolveFileReference') as RegisteredHandler
    const result = (await resolve({}, 'ChatPanel.tsx', workspaceState.root)) as {
      ok: boolean
      matches: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.matches).toEqual(['src/components/ChatPanel.tsx'])
  })

  it('reports a mention the model imagined as unresolved so it stays plain text', async () => {
    const resolve = handlers.get('workspace:resolveFileReference') as RegisteredHandler
    const result = (await resolve({}, 'src/Missing.tsx', workspaceState.root)) as {
      ok: boolean
      matches: string[]
    }
    expect(result).toEqual({ ok: false, matches: [] })
  })
})

describe('workspace watcher resilience', () => {
  function fakeWatcher(): {
    on: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    fail: (error: Error) => void
  } {
    const listeners = new Map<string, (error: Error) => void>()
    return {
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        listeners.set(event, handler)
      }),
      close: vi.fn(),
      fail: (error: Error) => listeners.get('error')?.(error)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    watchMock.mockReset()
    appState.workspaceWatcher = null
    appState.watchDebounceTimer = null
    appState.mainWindowRef = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as typeof appState.mainWindowRef
  })

  afterEach(() => {
    startWorkspaceWatcher(null)
    vi.useRealTimers()
    appState.mainWindowRef = null
  })

  it('re-establishes a watch that drops instead of going silent for the session', async () => {
    const first = fakeWatcher()
    const second = fakeWatcher()
    watchMock.mockReturnValueOnce(first).mockReturnValueOnce(second)

    startWorkspaceWatcher('C:\\project')
    expect(watchMock).toHaveBeenCalledTimes(1)

    first.fail(new Error('EPERM'))
    expect(appState.workspaceWatcher).toBeNull()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(appState.workspaceWatcher).toBe(second)
  })

  it('stops retrying a folder that never comes back', async () => {
    watchMock.mockImplementation(() => {
      const watcher = fakeWatcher()
      queueMicrotask(() => watcher.fail(new Error('ENOENT')))
      return watcher
    })

    startWorkspaceWatcher('C:\\deleted')
    await vi.advanceTimersByTimeAsync(60_000)

    // One initial attempt plus the bounded retry budget, then it gives up
    // rather than spinning for the lifetime of the app.
    expect(watchMock).toHaveBeenCalledTimes(6)
  })
})
