import type Database from 'better-sqlite3'
import {
  normalizePermissionMode,
  type PermissionAuditRecord,
  type PermissionOperationKind,
  type RequestedAccess
} from '../../shared/permissions'
import { fingerprintOperation } from './permissionBroker'

interface PermissionEventRow {
  id: string
  run_id: string
  type: 'permission.requested' | 'permission.resolved'
  payload_json: string
  timestamp: number
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function access(value: unknown, fallback: RequestedAccess): RequestedAccess {
  return value === 'confirm' || value === 'auto' ? value : fallback
}

function operationKind(name: string): PermissionOperationKind {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name === 'shell' || name === 'cancel_background_task') return 'command'
  if (name.startsWith('browser_')) return 'browser'
  if (name.includes('checkpoint')) return 'checkpoint'
  return 'workspace'
}

function displayTitle(name: string): string {
  return name ? name.replaceAll('_', ' ') : 'Sensitive agent operation'
}

/**
 * Projects kernel permission events into the same audit contract used by
 * user-initiated privileged actions. The event ledger remains authoritative;
 * this function creates no second mutable permission history.
 */
export function listAgentPermissionAudit(
  db: Database.Database,
  limit = 500
): PermissionAuditRecord[] {
  const rows = db
    .prepare(
      `SELECT id, run_id, type, payload_json, timestamp
       FROM agent_run_events
       WHERE type IN ('permission.requested', 'permission.resolved')
       ORDER BY timestamp DESC, sequence DESC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(5_000, limit * 2))) as PermissionEventRow[]

  const requests = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (row.type !== 'permission.requested') continue
    const payload = parseRecord(row.payload_json)
    const interactionId = String(payload.interactionId || '')
    const request = payload.request
    if (interactionId && request && typeof request === 'object') {
      requests.set(interactionId, request as Record<string, unknown>)
    }
  }

  return rows
    .filter((row) => row.type === 'permission.resolved')
    .slice(0, limit)
    .map((row): PermissionAuditRecord => {
      const resolved = parseRecord(row.payload_json)
      const interactionId = String(resolved.interactionId || '')
      const request = requests.get(interactionId) ?? resolved
      const response =
        resolved.response && typeof resolved.response === 'object'
          ? (resolved.response as Record<string, unknown>)
          : resolved
      const name = String(request.name || resolved.name || '')
      const requestedAccess = access(request.requestedAccess ?? resolved.requestedAccess, 'auto')
      const effectiveAccess = access(
        resolved.effectiveAccess,
        interactionId ? 'confirm' : requestedAccess
      )
      const mode = normalizePermissionMode(request.mode ?? resolved.mode)
      const approved = response.approved === true && resolved.status !== 'cancelled'
      const kind = operationKind(name)
      const title = String(request.title || resolved.title || displayTitle(name)).slice(0, 500)
      const details =
        request.arguments && typeof request.arguments === 'object'
          ? (request.arguments as Record<string, unknown>)
          : {}

      return {
        id: `agent:${row.id}`,
        timestamp: row.timestamp,
        event: 'authorization',
        operationKind: kind,
        title,
        requestedAccess,
        effectiveAccess,
        mode,
        fingerprint: fingerprintOperation({
          kind,
          title,
          requestedAccess,
          details: {
            runId: row.run_id,
            toolCallId: request.toolCallId ?? resolved.toolCallId ?? '',
            name,
            arguments: details
          }
        }),
        outcome: approved
          ? effectiveAccess === 'confirm'
            ? 'user-approved'
            : 'auto-approved'
          : 'denied',
        ...(!approved
          ? {
              reason:
                resolved.status === 'cancelled'
                  ? 'Run ended before approval'
                  : 'Operation denied by user'
            }
          : {})
      }
    })
}
