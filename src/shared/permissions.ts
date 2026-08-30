export type PermissionMode = 'full-access' | 'sensitive-only' | 'always-ask'
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
  if (value === 'always-ask' || value === 'sensitive-only' || value === 'full-access') return value
  // Migrate the two historical values without preserving them in the runtime contract.
  if (value === 'agent-decides') return 'sensitive-only'
  if (value === 'bypass') return 'full-access'
  return 'full-access'
}

/**
 * Resolve the user's global approval mode against the access level classified by the host.
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

  if (mode === 'full-access') {
    return {
      effectiveAccess: 'auto',
      source: mode,
      reason: 'Full access runs in-scope operations without approval prompts.'
    }
  }

  return {
    effectiveAccess: requestedAccess,
    source: mode,
    reason:
      requestedAccess === 'confirm'
        ? 'SideKick classified this operation as requiring approval.'
        : 'SideKick classified this operation as safe to run automatically.'
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
      return 'The app is in Always ask mode. SideKick asks before every host-classified sensitive operation.'
    case 'full-access':
      return 'The app is in Full access mode. In-scope tools and commands run without approval prompts. Continue autonomously while respecting the user request and destructive-action safeguards.'
    default:
      return 'The app is in Sensitive actions mode. Safe inspection, ordinary workspace edits, and non-destructive validation run automatically; destructive operations and external side effects require approval.'
  }
}
