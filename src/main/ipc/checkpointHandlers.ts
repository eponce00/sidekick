import { ipcMain } from 'electron'
import {
  checkpointPermissionOperation,
  type CheckpointMutationAction
} from '../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../shared/types'
import { permissionBroker } from '../services/permissionBroker'
import { appState } from './state'
import { getDb } from './state'
import { resolveKnownWorkspace } from './workspaceUtils'
import { CheckpointTitleStore } from '../services/checkpointTitleStore'
import {
  isCheckpointTitleSource,
  type CheckpointTitleIdentity,
  type CompleteCheckpointTitleBackfillInput,
  type FailCheckpointTitleBackfillInput
} from '../../shared/checkpointTitles'
import {
  createCheckpoint,
  beginCheckpointCapture,
  discardCheckpointCapture,
  restoreCheckpoint,
  hardResetCheckpoint,
  rewindToBeforeCheckpoint,
  listCheckpoints,
  getCheckpointDiff,
  getHistoryStatus
} from '../services/checkpoints'

export function registerCheckpointHandlers(): void {
  const db = getDb()
  const checkpointTitles = new CheckpointTitleStore(db)
  const validHash = (hash: unknown): hash is string =>
    typeof hash === 'string' && /^[0-9a-f]{7,64}$/i.test(hash)
  const resolveIdentity = (input: unknown): CheckpointTitleIdentity => {
    if (!input || typeof input !== 'object') throw new Error('Invalid checkpoint title identity')
    const candidate = input as Record<string, unknown>
    const workspaceRoot = resolveKnownWorkspace(candidate.workspaceRoot)
    if (
      !validHash(candidate.hash) ||
      typeof candidate.expectedTitle !== 'string' ||
      candidate.expectedTitle.length > 500
    ) {
      throw new Error('Invalid checkpoint title identity')
    }
    return {
      workspaceRoot,
      hash: candidate.hash,
      expectedTitle: candidate.expectedTitle
    }
  }
  const consumeCheckpointAuthorization = (
    action: CheckpointMutationAction,
    hash: string,
    authorization: CheckpointMutationAuthorization | undefined
  ): void => {
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error('Invalid checkpoint hash')
    permissionBroker.consume(
      authorization?.authorizationToken,
      checkpointPermissionOperation(action, hash, 'confirm')
    )
  }

  const mutationResponse = (
    result: Awaited<ReturnType<typeof restoreCheckpoint>>
  ): {
    ok: boolean
    changedFiles?: number
    conflicts?: typeof result.conflicts
    error?: string
  } => {
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

  ipcMain.handle('workspace:discardHistoryCapture', (_, captureId: string) => {
    if (typeof captureId === 'string' && captureId.length <= 500) {
      discardCheckpointCapture(captureId)
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
        checkpointTitles.recordCreated(workspaceRoot, checkpoint.hash, message)
        return { ok: true, ...checkpoint }
      } catch (err) {
        return { ok: false, error: (err as Error).message, hash: null }
      }
    }
  )

  ipcMain.handle(
    'workspace:restoreCheckpoint',
    async (_, passedRoot: string, hash: string, authorization: CheckpointMutationAuthorization) => {
      if (!appState.gitAvailable) return { ok: false, error: 'git not available' }
      try {
        consumeCheckpointAuthorization('restore', hash, authorization)
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        return mutationResponse(await restoreCheckpoint(workspaceRoot, hash))
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('workspace:listCheckpoints', async (_, passedRoot: string) => {
    try {
      const workspaceRoot = resolveKnownWorkspace(passedRoot)
      const checkpoints = checkpointTitles.sync(workspaceRoot, await listCheckpoints(workspaceRoot))
      return { ok: true, checkpoints, status: await getHistoryStatus(workspaceRoot) }
    } catch (err) {
      return { ok: false, checkpoints: [], error: (err as Error).message }
    }
  })

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

  ipcMain.handle('workspace:getCheckpointDiff', async (_, passedRoot: string, hash: string) => {
    try {
      if (!validHash(hash)) throw new Error('Invalid checkpoint hash')
      const workspaceRoot = resolveKnownWorkspace(passedRoot)
      const diff = await getCheckpointDiff(workspaceRoot, hash)
      return { ok: true, diff }
    } catch (err) {
      return { ok: false, diff: '', error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'workspace:renameCheckpoint',
    async (_, passedRoot: string, hash: string, newMessage: string, requestedSource?: unknown) => {
      try {
        const workspaceRoot = resolveKnownWorkspace(passedRoot)
        if (
          !validHash(hash) ||
          typeof newMessage !== 'string' ||
          !newMessage.trim() ||
          newMessage.length > 500
        ) {
          throw new Error('Invalid checkpoint label')
        }
        const source = isCheckpointTitleSource(requestedSource) ? requestedSource : 'user'
        let applied = checkpointTitles.updateLabel(workspaceRoot, hash, newMessage, source)
        if (!applied) {
          checkpointTitles.sync(workspaceRoot, await listCheckpoints(workspaceRoot))
          applied = checkpointTitles.updateLabel(workspaceRoot, hash, newMessage, source)
        }
        return applied ? { ok: true } : { ok: false, error: 'Checkpoint not found' }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'workspace:claimCheckpointTitleBackfill',
    async (_, input: CheckpointTitleIdentity) => {
      const identity = resolveIdentity(input)
      return { claimed: checkpointTitles.claim(identity) }
    }
  )

  ipcMain.handle(
    'workspace:completeCheckpointTitleBackfill',
    async (_, input: CompleteCheckpointTitleBackfillInput) => {
      const identity = resolveIdentity(input)
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) {
        throw new Error('Invalid completed checkpoint title')
      }
      return { applied: checkpointTitles.complete({ ...identity, title: input.title }) }
    }
  )

  ipcMain.handle(
    'workspace:failCheckpointTitleBackfill',
    async (_, input: FailCheckpointTitleBackfillInput) => {
      const identity = resolveIdentity(input)
      if (typeof input.error !== 'string' || input.error.length > 2_000) {
        throw new Error('Invalid failed checkpoint title')
      }
      return { recorded: checkpointTitles.fail({ ...identity, error: input.error }) }
    }
  )

  ipcMain.handle(
    'workspace:getCheckpointTitleContext',
    async (_, passedRoot: string, hash: string, timestamp: number) => {
      const workspaceRoot = resolveKnownWorkspace(passedRoot)
      if (!validHash(hash) || !Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error('Invalid checkpoint title context request')
      }
      return checkpointTitles.findContext(workspaceRoot, hash, timestamp)
    }
  )
}
