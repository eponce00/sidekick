import { historyRestorePermissionOperation } from '../../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../../shared/types'
import type { HistoryRestoreTarget } from '../../../shared/workspaceHistory'

export async function authorizeCheckpointMutation(
  targets: HistoryRestoreTarget[]
): Promise<CheckpointMutationAuthorization | null> {
  // Recovery actions are initiated by an explicit Undo or Rewind click and, where
  // destructive, an in-app confirmation. Respect Always Ask globally without forcing a
  // second native prompt in Full Access mode.
  const operation = historyRestorePermissionOperation(targets, 'auto')
  const authorization = await window.api.permissions.authorize(operation)
  if (!authorization.approved || !authorization.token) return null
  return {
    requestedAccess: 'auto',
    authorizationToken: authorization.token
  }
}
