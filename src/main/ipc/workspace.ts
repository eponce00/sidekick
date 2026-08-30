import {
  BrowserWindow,
  Menu,
  clipboard,
  ipcMain,
  dialog,
  shell,
  type OpenDialogOptions
} from 'electron'
import { basename, isAbsolute, join, relative } from 'path'
import { getStore } from './state'
import { getStoredWorkspace, resolveKnownWorkspace, assertInsideWorkspace } from './workspaceUtils'
import { appState } from './state'
import { watch as fsWatch } from 'fs'
import { promises as fs } from 'fs'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import {
  beginWorkspaceInstructionScope,
  clearWorkspaceInstructionScope,
  loadWorkspaceRules,
  resetWorkspaceInstructionScope,
  resolveWorkspaceInstructionsForPath
} from '../services/workspaceRules'
import { workspacePermissionOperation } from '../../shared/permissions'
import type { WorkspaceMutationAuthorization } from '../../shared/types'
import { permissionBroker } from '../services/permissionBroker'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import { WorkspaceReadService } from '../services/workspaceReadService'
import { discoverExternalOpeners } from '../services/externalOpeners'
import type { MessageContextAttachment } from '../../shared/messageContextAttachments'

const workspaceReads = new WorkspaceReadService()

export function startWorkspaceWatcher(folderPath: string | null): void {
  if (appState.workspaceWatcher) {
    appState.workspaceWatcher.close()
    appState.workspaceWatcher = null
  }
  if (appState.watchDebounceTimer) {
    clearTimeout(appState.watchDebounceTimer)
    appState.watchDebounceTimer = null
  }
  if (!folderPath || !appState.mainWindowRef || appState.mainWindowRef.isDestroyed()) return
  try {
    appState.workspaceWatcher = fsWatch(folderPath, { recursive: true }, (_eventType, filename) => {
      const name = filename ? filename.toString() : ''
      if (name.startsWith('.git') || name.startsWith('.git\\') || name.startsWith('.git/')) return
      if (appState.watchDebounceTimer) clearTimeout(appState.watchDebounceTimer)
      appState.watchDebounceTimer = setTimeout(() => {
        appState.watchDebounceTimer = null
        if (appState.mainWindowRef && !appState.mainWindowRef.isDestroyed()) {
          appState.mainWindowRef.webContents.send('workspace:filesChanged')
        }
      }, 400)
    })
    appState.workspaceWatcher.on('error', (err) => {
      console.warn('[FileWatcher] Error:', err)
      appState.workspaceWatcher?.close()
      appState.workspaceWatcher = null
    })
  } catch (err) {
    console.warn('[FileWatcher] Could not start watcher:', err)
  }
}

export function registerWorkspaceHandlers(): void {
  // Workspace: native folder picker
  ipcMain.handle('workspace:selectFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Open Project Folder'
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('workspace:selectContextAttachments', async (event, passedRoot: string) => {
    try {
      const workspaceRoot = resolveKnownWorkspace(passedRoot)
      const canonicalRoot = await fs.realpath(workspaceRoot)
      const win = BrowserWindow.fromWebContents(event.sender)
      const choiceOptions = {
        type: 'question' as const,
        title: 'Attach project context',
        message: 'Choose files or one folder from this project',
        detail: 'SideKick stores project-relative references and reads them only when relevant.',
        buttons: ['Choose files', 'Choose folder', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      }
      const choice = win
        ? await dialog.showMessageBox(win, choiceOptions)
        : await dialog.showMessageBox(choiceOptions)
      if (choice.response === 2) return { ok: true, canceled: true, attachments: [] }

      const selectFolder = choice.response === 1
      const openOptions: OpenDialogOptions = {
        title: selectFolder ? 'Attach a project folder' : 'Attach project files',
        defaultPath: workspaceRoot,
        buttonLabel: 'Attach',
        properties: selectFolder ? ['openDirectory'] : ['openFile', 'multiSelections']
      }
      const selection = win
        ? await dialog.showOpenDialog(win, openOptions)
        : await dialog.showOpenDialog(openOptions)
      if (selection.canceled || !selection.filePaths.length) {
        return { ok: true, canceled: true, attachments: [] }
      }

      const attachments: MessageContextAttachment[] = []
      for (const selectedPath of selection.filePaths.slice(0, 12)) {
        const canonicalPath = await fs.realpath(selectedPath)
        const relativePath = relative(canonicalRoot, canonicalPath)
        if (
          !relativePath ||
          relativePath === '..' ||
          relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error('Choose files or folders inside the current project')
        }
        const stat = await fs.stat(canonicalPath)
        if (selectFolder ? !stat.isDirectory() : !stat.isFile()) {
          throw new Error(selectFolder ? 'Choose a project folder' : 'Choose project files')
        }
        attachments.push({
          id: randomUUID(),
          kind: selectFolder ? ('folder' as const) : ('file' as const),
          name: basename(canonicalPath),
          relativePath: relativePath.replaceAll('\\', '/'),
          ...(stat.isFile() ? { size: stat.size } : {})
        })
      }
      return { ok: true, canceled: false, attachments }
    } catch (error) {
      return { ok: false, canceled: false, attachments: [], error: (error as Error).message }
    }
  })

  // Workspace: persist folder path in electron-store
  ipcMain.handle('workspace:getPath', async () => {
    return getStore().get('workspacePath', null) as string | null
  })

  ipcMain.handle('workspace:getRules', async (_, passedRoot?: string, scopeId?: string) => {
    try {
      const workspaceRoot = resolveKnownWorkspace(passedRoot)
      const rules = scopeId
        ? await beginWorkspaceInstructionScope(scopeId, workspaceRoot)
        : await loadWorkspaceRules(workspaceRoot)
      return { ok: true, ...rules }
    } catch (error) {
      return {
        ok: false,
        content: '',
        sources: [],
        sourceDetails: [],
        truncated: false,
        error: (error as Error).message
      }
    }
  })

  ipcMain.handle(
    'workspace:resolveRulesForPath',
    async (
      _,
      passedRoot: string,
      targetPath: string,
      scopeId: string,
      isDirectory = false,
      mutation = false
    ) => {
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        return {
          ok: true,
          ...(await resolveWorkspaceInstructionsForPath(
            scopeId,
            workspaceRoot,
            targetPath,
            isDirectory,
            mutation
          ))
        }
      } catch (error) {
        return {
          ok: false,
          content: '',
          sources: [],
          sourceDetails: [],
          truncated: false,
          retryRequired: false,
          error: (error as Error).message
        }
      }
    }
  )

  ipcMain.handle('workspace:resetRuleScope', (_event, scopeId: string) => {
    resetWorkspaceInstructionScope(scopeId)
    return { ok: true }
  })

  ipcMain.handle('workspace:clearRuleScope', (_event, scopeId: string) => {
    clearWorkspaceInstructionScope(scopeId)
    return { ok: true }
  })

  ipcMain.handle('workspace:setPath', async (_, folderPath: string | null) => {
    getStore().set('workspacePath', folderPath)
    startWorkspaceWatcher(folderPath)
    return { success: true }
  })

  // Workspace: search files with regex
  ipcMain.handle(
    'workspace:searchFiles',
    async (
      _,
      passedRoot: string,
      searchPath: string,
      regexPattern: string,
      filePattern?: string,
      contextLines?: number
    ) => {
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        const result = await workspaceReads.searchFiles(workspaceRoot, {
          path: searchPath,
          regex: regexPattern,
          filePattern,
          contextLines
        })
        return {
          ok: true,
          output: result.output,
          matchCount: result.matchCount,
          matchedFiles: result.matchedFiles,
          truncated: result.truncated
        }
      } catch (err) {
        return {
          ok: false,
          error: (err as Error).message,
          output: '',
          matchCount: 0,
          matchedFiles: []
        }
      }
    }
  )

  // Workspace: list files recursively (max depth 4, skips dot-files)
  ipcMain.handle(
    'workspace:listFiles',
    async (_, passedRoot: string, subPath?: string, globPattern?: string) => {
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        const result = await workspaceReads.listFiles(workspaceRoot, {
          subPath,
          glob: globPattern
        })
        return { ok: true, ...result }
      } catch (err) {
        return { ok: false, error: (err as Error).message, files: [] }
      }
    }
  )

  // Workspace: read file contents
  ipcMain.handle(
    'workspace:readFile',
    async (_, passedRoot: string, filePath: string, startLine?: number, endLine?: number) => {
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        return {
          ok: true,
          ...(await workspaceReads.readFile(workspaceRoot, filePath, { startLine, endLine }))
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message, content: null }
      }
    }
  )

  // Workspace: move a user-selected file to the system Trash / Recycle Bin.
  ipcMain.handle(
    'workspace:trashFile',
    async (
      _,
      passedRoot: string,
      filePath: string,
      authorization: WorkspaceMutationAuthorization
    ) => {
      try {
        permissionBroker.consume(
          authorization?.authorizationToken,
          workspacePermissionOperation(
            'delete',
            filePath,
            undefined,
            authorization?.requestedAccess ?? 'confirm'
          )
        )
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        const fullPath = join(workspaceRoot, filePath)
        assertInsideWorkspace(fullPath, workspaceRoot)
        await shell.trashItem(fullPath)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  const resolveShellTarget = async (
    requestedPath: string,
    passedRoot?: string
  ): Promise<string> => {
    const workspaceRoot = passedRoot ? resolveKnownWorkspace(passedRoot) : getStoredWorkspace()
    if (isAbsolute(requestedPath)) {
      const relativeTarget = relative(workspaceRoot, requestedPath)
      return resolveSecureWorkspacePath(workspaceRoot, relativeTarget)
    }
    return resolveSecureWorkspacePath(workspaceRoot, requestedPath)
  }

  // Shell integrations are restricted to the active workspace. In particular,
  // shell.openPath must never become a renderer-controlled executable launcher.
  ipcMain.handle('workspace:openFolder', async (_, folderPath: string, passedRoot?: string) => {
    const error = await shell.openPath(await resolveShellTarget(folderPath, passedRoot))
    if (error) throw new Error(error)
  })
  ipcMain.handle('workspace:openFile', async (_, filePath: string, passedRoot?: string) => {
    const error = await shell.openPath(await resolveShellTarget(filePath, passedRoot))
    if (error) throw new Error(error)
  })
  ipcMain.handle(
    'workspace:openFileReference',
    async (event, fileReference: string, passedRoot?: string) => {
      try {
        const workspaceRoot = passedRoot ? resolveKnownWorkspace(passedRoot) : getStoredWorkspace()
        const directTarget = await resolveShellTarget(fileReference, passedRoot)
        const directStat = await fs.stat(directTarget).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (directStat?.isFile()) {
          const error = await shell.openPath(directTarget)
          return error
            ? { ok: false, status: 'not_found' as const, error }
            : { ok: true, status: 'opened' as const, path: directTarget }
        }

        if (isAbsolute(fileReference)) {
          return {
            ok: false,
            status: 'not_found' as const,
            error: 'File not found in this project'
          }
        }
        const normalizedReference = fileReference.replace(/\\/g, '/').replace(/^\.\//, '')
        const fileName = basename(normalizedReference)
        const listed = await workspaceReads.listFiles(workspaceRoot, {
          glob: `**/${fileName}`,
          maxResults: 50
        })
        const comparable = (value: string): string =>
          process.platform === 'win32' ? value.toLowerCase() : value
        const wantedSuffix = comparable(normalizedReference)
        const matches = listed.files
          .filter((candidate) => {
            const normalized = comparable(candidate.replace(/\\/g, '/'))
            return normalized === wantedSuffix || normalized.endsWith(`/${wantedSuffix}`)
          })
          .slice(0, 20)

        if (matches.length === 1) {
          const target = await resolveSecureWorkspacePath(workspaceRoot, matches[0])
          const error = await shell.openPath(target)
          return error
            ? { ok: false, status: 'not_found' as const, error }
            : { ok: true, status: 'opened' as const, path: target }
        }
        if (matches.length > 1) {
          const menu = Menu.buildFromTemplate(
            matches.map((match) => ({
              label: match,
              click: () => {
                void resolveSecureWorkspacePath(workspaceRoot, match)
                  .then((target) => shell.openPath(target))
                  .then((error) => {
                    if (error) console.warn('[Workspace] Could not open file reference:', error)
                  })
              }
            }))
          )
          const window = BrowserWindow.fromWebContents(event.sender)
          menu.popup(window ? { window } : undefined)
          return { ok: true, status: 'choose' as const, matches }
        }
        return { ok: false, status: 'not_found' as const, error: 'File not found in this project' }
      } catch (error) {
        return { ok: false, status: 'not_found' as const, error: (error as Error).message }
      }
    }
  )
  ipcMain.handle('workspace:revealFile', async (_, filePath: string, passedRoot?: string) => {
    shell.showItemInFolder(await resolveShellTarget(filePath, passedRoot))
  })
  ipcMain.handle(
    'workspace:showPathMenu',
    async (event, requestedPath: string, passedRoot?: string, isDirectory = false) => {
      const workspaceRoot = passedRoot ? resolveKnownWorkspace(passedRoot) : getStoredWorkspace()
      const target = await resolveShellTarget(requestedPath, passedRoot)
      const relativePath = relative(workspaceRoot, target).replace(/\\/g, '/')
      const revealLabel = process.platform === 'win32' ? 'Show in File Explorer' : 'Show in Folder'
      const openers = await discoverExternalOpeners()
      const editors = openers.filter((opener) => opener.kind === 'editor')
      const terminals = openers.filter((opener) => opener.kind === 'terminal')
      const launch = (opener: (typeof openers)[number]): void => {
        const child = spawn(opener.executable, opener.args(target, isDirectory), {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        child.on('error', (error) =>
          console.warn(`[Workspace] Could not open ${opener.label}:`, error)
        )
        child.unref()
      }
      const primaryEditor = editors[0]
      const menu = Menu.buildFromTemplate([
        ...(primaryEditor
          ? [
              {
                label: `Open in ${primaryEditor.label}`,
                icon: primaryEditor.icon,
                click: () => launch(primaryEditor)
              }
            ]
          : []),
        {
          label: 'Open with',
          submenu: [
            ...editors.map((opener) => ({
              label: opener.label,
              icon: opener.icon,
              click: () => launch(opener)
            })),
            ...(editors.length ? [{ type: 'separator' as const }] : []),
            {
              label: 'Default app',
              click: () => {
                void shell.openPath(target).then((error) => {
                  if (error) console.warn('[Workspace] Could not open path:', error)
                })
              }
            },
            ...(!isDirectory && process.platform === 'win32'
              ? [
                  {
                    label: 'Choose another app…',
                    click: () => {
                      const chooser = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: false
                      })
                      chooser.unref()
                    }
                  }
                ]
              : []),
            {
              label: revealLabel,
              click: () => shell.showItemInFolder(target)
            },
            ...terminals.map((opener) => ({
              label: opener.label,
              icon: opener.icon,
              click: () => launch(opener)
            }))
          ]
        },
        { type: 'separator' },
        {
          label: revealLabel,
          click: () => shell.showItemInFolder(target)
        },
        { type: 'separator' },
        {
          label: 'Copy Full Path',
          click: () => clipboard.writeText(target)
        },
        {
          label: 'Copy Project-Relative Path',
          click: () => clipboard.writeText(relativePath)
        }
      ])
      const window = BrowserWindow.fromWebContents(event.sender)
      menu.popup(window ? { window } : undefined)
    }
  )
}
