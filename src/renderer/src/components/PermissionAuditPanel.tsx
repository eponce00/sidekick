import { useCallback, useState } from 'react'
import { ChevronDown, History, RefreshCw } from 'lucide-react'
import type { PermissionAuditRecord } from '../../../shared/permissions'
import { SettingsRow } from './SettingsLayout'
import './PermissionAuditPanel.css'

const DECISION_LABELS: Record<NonNullable<PermissionAuditRecord['decision']>, string> = {
  allow_once: 'allowed once',
  allow_chat: 'allowed for chat',
  deny: 'denied',
  deny_stop: 'denied and stopped',
  chat_grant: 'allowed by chat grant'
}

function outcomeLabel(record: PermissionAuditRecord): string {
  return record.decision ? DECISION_LABELS[record.decision] : record.outcome.replace('-', ' ')
}

export function PermissionAuditPanel(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [records, setRecords] = useState<PermissionAuditRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setRecords((await window.api.permissions.listAudit()).slice(-25).reverse())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load audit history')
    } finally {
      setLoading(false)
    }
  }, [])

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next) void load()
  }

  return (
    <SettingsRow
      icon={History}
      className="permission-audit"
      label="Authorization audit"
      description="The latest agent decisions and grants, newest first."
      control={
        <button
          type="button"
          className="settings-secondary-action permission-audit-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide authorization audit' : 'View authorization audit'}
        >
          {expanded ? 'Hide' : 'View'}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      }
    >
      {expanded && (
        <div className="permission-audit-content">
          <div className="permission-audit-header">
            <span>
              {loading
                ? 'Loading…'
                : `${records.length} recent event${records.length === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              className="settings-ghost-action is-small is-icon"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh authorization audit"
            >
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            </button>
          </div>
          {error && <div className="permission-audit-empty">{error}</div>}
          {!error && !loading && records.length === 0 && (
            <div className="permission-audit-empty">No authorization activity recorded yet.</div>
          )}
          {records.map((record) => (
            <div className="permission-audit-record" key={record.id}>
              <div className="permission-audit-record-main">
                <span className={`permission-audit-outcome outcome-${record.outcome}`}>
                  {outcomeLabel(record)}
                </span>
                <span className="permission-audit-title">{record.title}</span>
              </div>
              <div className="permission-audit-meta">
                {record.operationKind} · {record.mode} · {record.requestedAccess} →{' '}
                {record.effectiveAccess} · {new Date(record.timestamp).toLocaleString()} ·{' '}
                {record.fingerprint.slice(0, 10)}
              </div>
              {record.reason && <div className="permission-audit-reason">{record.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </SettingsRow>
  )
}
