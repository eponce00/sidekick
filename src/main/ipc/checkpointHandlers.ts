import { ipcMain } from 'electron'
import {
  checkpointPermissionOperation,
  type CheckpointMutationAction
} from '../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../shared/types'
import type { HistoryMutationResult } from '../../shared/workspaceHistory'
import { permissionBroker } from '../services/permissionBroker'
import { appState } from './state'
import { resolveKnownWorkspace } from './workspaceUtils'
import {
  createCheckpoint,
  beginCheckpointCapture,
  discardCheckpointCapture,
  hardResetCheckpoint,
  rewindToBeforeCheckpoint
} from '../services/checkpoints'

export function registerCheckpointHandlers(): void {
  const consumeCheckpointAuthorization = (
    action: CheckpointMutationAction,
    hash: string,
    authorization: CheckpointMutationAuthorization | undefined
  ): void => {
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('Invalid checkpoint hash')
    permissionBroker.consume(
      authorization?.authorizationToken,
      checkpointPermissionOperation(action, hash, authorization?.requestedAccess ?? 'confirm')
    )
  }

  const mutationResponse = (result: HistoryMutationResult): HistoryMutationResult => {
    if (result.ok) return { ok: true, changedFiles: result.changedFiles }
    return {
      ok: false,
      conflicts: result.conflicts,
      error:
        'Nothing was restored because one or more affected files changed after SideKick saved this history point.'
    }
  }

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

  ipcMain.handle(
    'workspace:rewindToBeforeCheckpoint',
    async (_, passedRoot: string, hash: string, authorization: CheckpointMutationAuthorization) => {
      if (!appState.gitAvailable) return { ok: false, error: 'git not available' }
      try {
        consumeCheckpointAuthorization('rewind', hash, authorization)
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        const result = await rewindToBeforeCheckpoint(workspaceRoot, hash)
        return { ...mutationResponse(result), parentHash: result.parentHash }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'workspace:hardResetCheckpoint',
    async (_, passedRoot: string, hash: string, authorization: CheckpointMutationAuthorization) => {
      if (!appState.gitAvailable) return { ok: false, error: 'git not available' }
      try {
        consumeCheckpointAuthorization('hard-reset', hash, authorization)
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        return mutationResponse(await hardResetCheckpoint(workspaceRoot, hash))
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('workspace:gitAvailable', async () => appState.gitAvailable)
}
