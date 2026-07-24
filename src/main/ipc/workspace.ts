import { BrowserWindow, ipcMain, dialog, shell, type OpenDialogOptions } from 'electron'
import { isAbsolute, join, relative } from 'path'
import { getStore } from './state'
import { getStoredWorkspace, resolveKnownWorkspace, assertInsideWorkspace } from './workspaceUtils'
import { appState } from './state'
import { watch as fsWatch } from 'fs'
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
  ipcMain.handle('workspace:revealFile', async (_, filePath: string, passedRoot?: string) => {
    shell.showItemInFolder(await resolveShellTarget(filePath, passedRoot))
  })
}
