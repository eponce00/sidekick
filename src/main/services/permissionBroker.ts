import { randomUUID, createHash } from 'crypto'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import {
  normalizePermissionMode,
  resolvePermissionPolicy,
  type PermissionAuthorization,
  type PermissionAuditRecord,
  type PermissionMode,
  type PermissionOperation
} from '../../shared/permissions'
import { getStore } from '../ipc/state'

interface Grant {
  fingerprint: string
  expiresAt: number
}

const GRANT_TTL_MS = 60_000
const MAX_DIALOG_DETAIL = 4_000
const MAX_AUDIT_RECORDS = 500

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    )
  }
  return value
}

export function fingerprintOperation(operation: PermissionOperation): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(operation)))
    .digest('hex')
}

function operationDetail(operation: PermissionOperation): string {
  const raw = Object.entries(operation.details)
    .filter(([key, value]) => key !== 'id' && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
  return raw.length > MAX_DIALOG_DETAIL
    ? `${raw.slice(0, MAX_DIALOG_DETAIL)}\n…detail truncated`
    : raw
}

export class PermissionBroker {
  private readonly grants = new Map<string, Grant>()

  private currentMode(): PermissionMode {
    const settings = getStore().get('settings', {}) as { commandPermissionMode?: unknown }
    return normalizePermissionMode(settings.commandPermissionMode)
  }

  private appendAudit(
    record: Omit<PermissionAuditRecord, 'id' | 'timestamp'>
  ): PermissionAuditRecord {
    const store = getStore()
    const existing = store.get('permissionAudit', [])
    const history = Array.isArray(existing) ? existing : []
    const complete: PermissionAuditRecord = {
      ...record,
      id: randomUUID(),
      timestamp: Date.now()
    }
    store.set('permissionAudit', [...history, complete].slice(-MAX_AUDIT_RECORDS))
    return complete
  }

  listAudit(): PermissionAuditRecord[] {
    const value = getStore().get('permissionAudit', [])
    return Array.isArray(value) ? (value as PermissionAuditRecord[]) : []
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token)
    }
  }

  async authorize(
    operation: PermissionOperation,
    sender: WebContents
  ): Promise<PermissionAuthorization> {
    this.cleanup()
    const mode = this.currentMode()
    const decision = resolvePermissionPolicy(mode, operation.requestedAccess)
    const fingerprint = fingerprintOperation(operation)

    if (decision.effectiveAccess === 'confirm') {
      const parent = BrowserWindow.fromWebContents(sender)
      const options = {
        type: 'warning' as const,
        title: 'SideKick approval required',
        message: operation.title,
        detail: operationDetail(operation),
        buttons: ['Deny', 'Approve'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) {
        const audit = this.appendAudit({
          event: 'authorization',
          operationKind: operation.kind,
          title: operation.title,
          requestedAccess: operation.requestedAccess,
          effectiveAccess: decision.effectiveAccess,
          mode,
          fingerprint,
          outcome: 'denied',
          reason: 'Operation denied by user'
        })
        return {
          approved: false,
          effectiveAccess: decision.effectiveAccess,
          reason: 'Operation denied by user',
          auditId: audit.id
        }
      }
    }

    const token = randomUUID()
    this.grants.set(token, {
      fingerprint,
      expiresAt: Date.now() + GRANT_TTL_MS
    })
    const audit = this.appendAudit({
      event: 'authorization',
      operationKind: operation.kind,
      title: operation.title,
      requestedAccess: operation.requestedAccess,
      effectiveAccess: decision.effectiveAccess,
      mode,
      fingerprint,
      outcome: decision.effectiveAccess === 'confirm' ? 'user-approved' : 'auto-approved'
    })
    return {
      approved: true,
      token,
      effectiveAccess: decision.effectiveAccess,
      auditId: audit.id
    }
  }

  consume(token: string | undefined, operation: PermissionOperation): void {
    this.cleanup()
    const mode = this.currentMode()
    const decision = resolvePermissionPolicy(mode, operation.requestedAccess)
    const fingerprint = fingerprintOperation(operation)
    const auditConsumption = (
      outcome: 'consumed' | 'rejected',
      reason?: string
    ): PermissionAuditRecord =>
      this.appendAudit({
        event: 'consumption',
        operationKind: operation.kind,
        title: operation.title,
        requestedAccess: operation.requestedAccess,
        effectiveAccess: decision.effectiveAccess,
        mode,
        fingerprint,
        outcome,
        reason
      })

    if (!token) {
      const reason = 'Authorization required for this operation'
      auditConsumption('rejected', reason)
      throw new Error(reason)
    }
    const grant = this.grants.get(token)
    this.grants.delete(token)
    if (!grant || grant.expiresAt <= Date.now()) {
      const reason = 'Authorization expired or was already used'
      auditConsumption('rejected', reason)
      throw new Error(reason)
    }
    if (grant.fingerprint !== fingerprint) {
      const reason = 'Authorization does not match this operation'
      auditConsumption('rejected', reason)
      throw new Error(reason)
    }
    auditConsumption('consumed')
  }
}

export const permissionBroker = new PermissionBroker()
