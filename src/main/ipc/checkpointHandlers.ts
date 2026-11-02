import { execFile } from 'child_process'
import { BrowserWindow, ipcMain, shell } from 'electron'
import { promisify } from 'util'
import { historyRestorePermissionOperation } from '../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../shared/types'
import type {
  GitInstallResult,
  HistoryMutationResult,
  HistoryRestoreTarget
} from '../../shared/workspaceHistory'
import { installGit } from '../services/gitInstaller'
import { permissionBroker } from '../services/permissionBroker'
import { showTrustedDialog } from '../services/trustedDialog'
import { appState } from './state'
import { resolveKnownWorkspace } from './workspaceUtils'
import {
  checkGitAvailable,
  createCheckpoint,
  beginCheckpointCapture,
  discardCheckpointCapture,
  restoreWorkspaceHistory
} from '../services/checkpoints'

/** The renderer's restore targets, each checked; a folder must be one SideKick knows. */
export function validHistoryTargets(raw: unknown): HistoryRestoreTarget[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) {
    throw new Error('Invalid history restore')
  }
  return raw.map((target) => {
    const { workspaceRoot, hashes } = (target ?? {}) as Partial<HistoryRestoreTarget>
    if (
      !Array.isArray(hashes) ||
      !hashes.length ||
      hashes.length > 500 ||
      hashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{7,64}$/i.test(hash))
    ) {
      throw new Error('Invalid checkpoint hash')
    }
    return { workspaceRoot: resolveKnownWorkspace(workspaceRoot), hashes: [...hashes] }
  })
}

/** Restores the folders together, after the approval the caller holds for exactly these targets. */
export async function restoreApprovedHistory(
  targets: HistoryRestoreTarget[]
): Promise<HistoryMutationResult> {
  const result = await restoreWorkspaceHistory(targets)
  if (result.ok) {
    return {
      ok: true,
      changedFiles: result.workspaces.reduce((total, folder) => total + folder.changedFiles, 0)
    }
  }
  return {
    ok: false,
    conflicts: result.conflicts,
    error:
      'Nothing was restored because one or more affected files changed after SideKick saved this history point.'
  }
}

const execFileAsync = promisify(execFile)

const GIT_DOWNLOAD_PAGE = 'https://git-scm.com/downloads'

async function refreshGitAvailable(): Promise<boolean> {
  if (!appState.gitAvailable) appState.gitAvailable = (await checkGitAvailable()) !== null
  return appState.gitAvailable
}

async function confirmGitInstall(parent: BrowserWindow | null): Promise<boolean> {
  const { response } = await showTrustedDialog(parent, {
    type: 'question',
    title: 'Install Git?',
    message: 'Install Git so SideKick can undo file changes?',
    detail:
      'SideKick installs it for your account with the Windows Package Manager. It usually takes about a minute, and your other apps stay as they are.',
    facts: [{ label: 'Package', value: 'Git.Git', code: true }],
    footnote: 'This accepts Git’s license, the GNU GPL v2, and the terms of the winget source.',
    buttons: ['Not now', 'Install Git'],
    cancelId: 0,
    defaultId: 1,
    noLink: true
  })
  return response === 1
}

let installingGit: Promise<GitInstallResult> | null = null

export function registerCheckpointHandlers(): void {
  ipcMain.handle(
    'workspace:beginHistoryCapture',
    async (_, passedRoot: string, conversationId: string, agentMessageId: string) => {
      if (!appState.gitAvailable) return { ok: false, captureId: null, error: 'git not available' }
      try {
        if (
          typeof conversationId !== 'string' ||
          !conversationId ||
          conversationId.length > 500 ||
          typeof agentMessageId !== 'string' ||
          !agentMessageId ||
          agentMessageId.length > 500
        ) {
          throw new Error('Invalid history capture identity')
        }
        const captureId = await beginCheckpointCapture(
          resolveKnownWorkspace(passedRoot),
          conversationId,
          agentMessageId
        )
        return { ok: true, captureId }
      } catch (err) {
        return { ok: false, captureId: null, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('workspace:discardHistoryCapture', async (_, captureId: string) => {
    if (typeof captureId === 'string' && captureId.length <= 500) {
      await discardCheckpointCapture(captureId)
    }
    return { ok: true }
  })

  ipcMain.handle(
    'workspace:createCheckpoint',
    async (_, passedRoot: string, message: string, captureId?: string) => {
      if (!appState.gitAvailable) return { ok: false, error: 'git not available', hash: null }
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        const checkpoint = await createCheckpoint(workspaceRoot, message, captureId)
        if (!checkpoint) return { ok: true, hash: null, changeCount: 0, captureVersion: 2 }
        return { ok: true, ...checkpoint }
      } catch (err) {
        return { ok: false, error: (err as Error).message, hash: null }
      }
    }
  )

  // Every folder of a reply's History goes back in one step, or none does.
  ipcMain.handle(
    'workspace:restoreHistory',
    async (
      _,
      rawTargets: unknown,
      authorization: CheckpointMutationAuthorization
    ): Promise<HistoryMutationResult> => {
      if (!appState.gitAvailable) return { ok: false, error: 'git not available' }
      try {
        const targets = validHistoryTargets(rawTargets)
        permissionBroker.consume(
          authorization?.authorizationToken,
          historyRestorePermissionOperation(
            rawTargets as HistoryRestoreTarget[],
            authorization?.requestedAccess ?? 'confirm'
          )
        )
        return await restoreApprovedHistory(targets)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('workspace:gitAvailable', async (_, lookAgain?: unknown) =>
    lookAgain === true ? refreshGitAvailable() : appState.gitAvailable
  )

  // Nothing here comes from the renderer but the request: what runs is fixed, and the user's yes is ours to ask for.
  ipcMain.handle('workspace:installGit', (event) => {
    installingGit ??= installGit({
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      gitWorks: refreshGitAvailable,
      run: async (file, args, ms) => {
        await execFileAsync(file, [...args], { windowsHide: true, timeout: ms })
      },
      confirm: () => confirmGitInstall(BrowserWindow.fromWebContents(event.sender)),
      openDownloadPage: () => shell.openExternal(GIT_DOWNLOAD_PAGE)
    }).finally(() => {
      installingGit = null
    })
    return installingGit
  })
}
