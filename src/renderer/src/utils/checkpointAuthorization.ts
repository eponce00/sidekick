import {
  checkpointPermissionOperation,
  type CheckpointMutationAction
} from '../../../shared/permissions'
import type { CheckpointMutationAuthorization } from '../../../shared/types'

export async function authorizeCheckpointMutation(
  action: CheckpointMutationAction,
  hash: string
): Promise<CheckpointMutationAuthorization | null> {
  const operation = checkpointPermissionOperation(action, hash, 'confirm')
  const authorization = await window.api.permissions.authorize(operation)
  if (!authorization.approved || !authorization.token) return null
  return {
    requestedAccess: 'confirm',
    authorizationToken: authorization.token
  }
}
