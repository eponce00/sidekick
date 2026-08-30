import {
  checkpointPermissionOperation,
  type CheckpointMutationAction
} from '../../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../../shared/types'

export async function authorizeCheckpointMutation(
  action: CheckpointMutationAction,
  hash: string
): Promise<CheckpointMutationAuthorization | null> {
  // Recovery actions are initiated by an explicit Undo/Rewind/Restore click and, where
  // destructive, an in-app confirmation. Respect Always Ask globally without forcing a
  // second native prompt in Full Access mode.
  const operation = checkpointPermissionOperation(action, hash, 'auto')
  const authorization = await window.api.permissions.authorize(operation)
  if (!authorization.approved || !authorization.token) return null
  return {
    requestedAccess: 'auto',
    authorizationToken: authorization.token
  }
}
