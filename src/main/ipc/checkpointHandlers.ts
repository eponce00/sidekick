import { ipcMain } from 'electron'
import { historyRestorePermissionOperation } from '../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../shared/types'
import type { HistoryMutationResult, HistoryRestoreTarget } from '../../shared/workspaceHistory'
import { permissionBroker } from '../services/permissionBroker'
import { appState } from './state'
import { resolveKnownWorkspace } from './workspaceUtils'
import {
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

  ipcMain.handle('workspace:gitAvailable', async () => appState.gitAvailable)
}
