import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { BrowserNetworkApproval } from '../../../shared/browserNetwork'

/** Local-network addresses the user let the browser open over plain HTTP, each removable. */
export function BrowserNetworkSettings(): React.JSX.Element {
  const [approvals, setApprovals] = useState<BrowserNetworkApproval[] | null>(null)

  useEffect(() => {
    let current = true
    void window.api.browserNetwork
      .list()
      .then((list) => current && setApprovals(list))
      .catch(() => current && setApprovals([]))
    return () => {
      current = false
    }
  }, [])

  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <h3>Local network</h3>
        <p>
          The browser opens plain HTTP on this computer, and on a local-network address, such as a
          device or gateway, only once you allow that address. Removing an address asks again next
          time.
        </p>
      </div>
      <div className="settings-card-content">
        {approvals && approvals.length > 0 ? (
          <ul className="project-hook-list">
            {approvals.map(({ origin, approvedAt }) => (
              <li key={origin} className="project-hook">
                <span className="project-hook-copy">
                  <code className="project-hook-command">{origin}</code>
                  <span className="project-hook-stage">
                    Allowed {new Date(approvedAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  className="project-hook-remove"
                  aria-label={`Remove ${origin}`}
                  title="Remove"
                  onClick={() =>
                    void window.api.browserNetwork
                      .revoke(origin)
                      .then(setApprovals)
                      .catch(() => undefined)
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          approvals && <small>No local-network addresses allowed yet.</small>
        )}
      </div>
    </section>
  )
}
