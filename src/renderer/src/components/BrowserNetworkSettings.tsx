import { useEffect, useState } from 'react'
import { Network, Trash2 } from 'lucide-react'
import type { BrowserNetworkApproval } from '../../../shared/browserNetwork'
import { SettingsEmptyState, SettingsRow, SettingsSection } from './SettingsLayout'

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
    <SettingsSection
      icon={Network}
      title="Local network"
      description="The browser opens plain HTTP on this computer, and on a local-network address, such as a device or gateway, only once you allow that address. Removing an address asks again next time."
    >
      {approvals && approvals.length > 0 ? (
        approvals.map(({ origin, approvedAt }) => (
          <SettingsRow
            key={origin}
            label={<code className="settings-origin">{origin}</code>}
            description={`Allowed ${new Date(approvedAt).toLocaleDateString()}`}
            control={
              <button
                type="button"
                className="settings-ghost-action is-small is-icon settings-remove-action"
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
            }
          />
        ))
      ) : (
        <SettingsEmptyState
          compact
          icon={Network}
          title={approvals ? 'No local-network addresses allowed yet.' : 'Loading…'}
        />
      )}
    </SettingsSection>
  )
}
