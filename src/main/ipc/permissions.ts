import { ipcMain } from 'electron'
import type { PermissionOperation } from '../../shared/permissions'
import { permissionBroker } from '../services/permissionBroker'

function validateOperation(value: unknown): value is PermissionOperation {
  if (!value || typeof value !== 'object') return false
  const operation = value as PermissionOperation
  let detailsLength = Number.POSITIVE_INFINITY
  try {
    detailsLength = JSON.stringify(operation.details).length
  } catch {
    return false
  }
  return (
    ['command', 'workspace', 'mcp', 'checkpoint', 'browser'].includes(operation.kind) &&
    typeof operation.title === 'string' &&
    operation.title.length > 0 &&
    operation.title.length <= 500 &&
    ['auto', 'confirm'].includes(operation.requestedAccess) &&
    Boolean(operation.details) &&
    typeof operation.details === 'object' &&
    detailsLength <= 4 * 1024 * 1024
  )
}

export function registerPermissionHandlers(): void {
  ipcMain.handle('permissions:authorize', async (event, operation: unknown) => {
    if (!validateOperation(operation)) {
      return { approved: false, effectiveAccess: 'confirm', reason: 'Invalid permission request' }
    }
    return permissionBroker.authorize(operation, event.sender)
  })
}
