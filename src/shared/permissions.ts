export type PermissionMode = 'always-ask' | 'agent-decides' | 'bypass'
export type RequestedAccess = 'auto' | 'confirm'
export type PermissionOperationKind = 'command' | 'workspace' | 'mcp' | 'checkpoint' | 'browser'

export interface PermissionOperation {
  kind: PermissionOperationKind
  title: string
  requestedAccess: RequestedAccess
  details: Record<string, unknown>
}

export interface PermissionAuthorization {
  approved: boolean
  token?: string
  effectiveAccess: RequestedAccess
  reason?: string
  auditId?: string
}

export interface PermissionAuditRecord {
  id: string
  timestamp: number
  event: 'authorization' | 'consumption'
  operationKind: PermissionOperationKind
  title: string
  requestedAccess: RequestedAccess
  effectiveAccess: RequestedAccess
  mode: PermissionMode
  fingerprint: string
  outcome: 'auto-approved' | 'user-approved' | 'denied' | 'consumed' | 'rejected'
  reason?: string
}

export type CheckpointMutationAction = 'restore' | 'hard-reset' | 'rewind'

export function commandPermissionOperation(request: {
  id: string
  title: string
  command: string
  cwd?: string
  timeoutSecs: number
  background: boolean
  requestedAccess: RequestedAccess
}): PermissionOperation {
  return {
    kind: 'command',
    title: request.title,
    requestedAccess: request.requestedAccess,
    details: {
      id: request.id,
      command: request.command,
      cwd: request.cwd ?? '',
      timeoutSecs: request.timeoutSecs,
      background: request.background
    }
  }
}

export function workspacePermissionOperation(
  action: 'write' | 'edit' | 'delete',
  filePath: string,
  payload: string | undefined,
  requestedAccess: RequestedAccess
): PermissionOperation {
  return {
    kind: 'workspace',
    title: `${action[0].toUpperCase()}${action.slice(1)} workspace file: ${filePath}`,
    requestedAccess,
    details: { action, filePath, payload: payload ?? '' }
  }
}

export function checkpointPermissionOperation(
  action: CheckpointMutationAction,
  hash: string,
  requestedAccess: RequestedAccess = 'confirm'
): PermissionOperation {
  const labels: Record<CheckpointMutationAction, string> = {
    restore: 'Restore workspace checkpoint',
    'hard-reset': 'Permanently reset workspace checkpoint history',
    rewind: 'Rewind workspace before checkpoint'
  }
  return {
    kind: 'checkpoint',
    title: `${labels[action]}: ${hash.slice(0, 12)}`,
    requestedAccess,
    details: { action, hash }
  }
}

export interface PermissionDecision {
  effectiveAccess: RequestedAccess
  source: PermissionMode
  reason: string
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === 'always-ask' || value === 'bypass') return value
  return 'agent-decides'
}

/**
 * Resolve the user's global approval mode against the access level requested by the agent.
 * This policy is authoritative for every sensitive operation.
 */
export function resolvePermissionPolicy(
  mode: PermissionMode,
  requestedAccess: RequestedAccess
): PermissionDecision {
  if (mode === 'always-ask') {
    return {
      effectiveAccess: 'confirm',
      source: mode,
      reason: 'Always ask mode requires approval for every sensitive operation.'
    }
  }

  if (mode === 'bypass') {
    return {
      effectiveAccess: 'auto',
      source: mode,
      reason: 'Bypass mode allows sensitive operations without approval.'
    }
  }

  return {
    effectiveAccess: requestedAccess,
    source: mode,
    reason:
      requestedAccess === 'confirm'
        ? 'The agent marked this operation as requiring approval.'
        : 'The agent marked this operation as safe to run automatically.'
  }
}

export function browserPermissionOperation(
  action: 'navigate' | 'download' | 'clipboard' | 'camera' | 'microphone',
  target: string,
  requestedAccess: RequestedAccess
): PermissionOperation {
  return {
    kind: 'browser',
    title: `Browser ${action}: ${target}`,
    requestedAccess,
    details: { action, target }
  }
}

export function getPermissionPrompt(mode: PermissionMode): string {
  switch (mode) {
    case 'always-ask':
      return 'The app is in Always ask mode. Every sensitive operation requires user approval regardless of accessLevel.'
    case 'bypass':
      return 'The app is in Full bypass mode. Sensitive operations run without approval. Still choose accessLevel honestly so the audit log records your safety judgment.'
    default:
      return 'The app is in Agent decides mode. Choose accessLevel="auto" only for safe, scoped, reversible work and accessLevel="confirm" for deletion, installation, system changes, credentials, external side effects, or other risky actions.'
  }
}
