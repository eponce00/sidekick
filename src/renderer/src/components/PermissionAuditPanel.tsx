import { useCallback, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import type { PermissionAuditRecord } from '../../../shared/permissions'
import './PermissionAuditPanel.css'

function outcomeLabel(outcome: PermissionAuditRecord['outcome']): string {
  return outcome.replace('-', ' ')
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
    <div className="permission-audit">
      <button
        type="button"
        className="permission-audit-toggle"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <ShieldCheck size={15} />
        {expanded ? 'Hide authorization audit' : 'View authorization audit'}
      </button>
      {expanded && (
        <div className="permission-audit-content">
          <div className="permission-audit-header">
            <span>Latest agent decisions and user-action grant events</span>
            <button
              type="button"
              className="permission-audit-refresh"
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
                  {outcomeLabel(record.outcome)}
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
    </div>
  )
}
