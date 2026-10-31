import { useEffect, useState } from 'react'
import { Network, Trash2 } from 'lucide-react'
import {
  certificateFingerprintHex,
  type BrowserCertificateApproval,
  type BrowserNetworkApproval
} from '../../../shared/browserNetwork'
import { SettingsEmptyState, SettingsRow, SettingsSection } from './SettingsLayout'

function RemoveButton({
  label,
  onRemove
}: {
  label: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="settings-ghost-action is-small is-icon settings-remove-action"
      aria-label={label}
      title="Remove"
      onClick={onRemove}
    >
      <Trash2 size={14} />
    </button>
  )
}

/**
 * Local-network addresses the user let the agent open over plain HTTP, and those whose untrusted
 * certificate they accepted, each removable.
 */
export function BrowserNetworkSettings(): React.JSX.Element {
  const [approvals, setApprovals] = useState<BrowserNetworkApproval[] | null>(null)
  const [certificates, setCertificates] = useState<BrowserCertificateApproval[] | null>(null)

  useEffect(() => {
    let current = true
    void window.api.browserNetwork
      .list()
      .then((list) => current && setApprovals(list))
      .catch(() => current && setApprovals([]))
    void window.api.browserNetwork
      .certificates()
      .then((list) => current && setCertificates(list))
      .catch(() => current && setCertificates([]))
    return () => {
      current = false
    }
  }, [])

  const loaded = approvals !== null && certificates !== null
  return (
    <SettingsSection
      icon={Network}
      title="Local network"
      description="Addresses on your network that you let the agent open in its browser or with web fetch, such as a router or a device, and devices whose untrusted certificate you accepted in the browser. Remove one to be asked again."
    >
      {approvals?.map(({ origin, approvedAt }) => (
        <SettingsRow
          key={origin}
          label={<code className="settings-origin">{origin}</code>}
          description={`Allowed ${new Date(approvedAt).toLocaleDateString()}`}
          control={
            <RemoveButton
              label={`Remove ${origin}`}
              onRemove={() =>
                void window.api.browserNetwork
                  .revoke(origin)
                  .then(setApprovals)
                  .catch(() => undefined)
              }
            />
          }
        />
      ))}
      {certificates?.map(({ origin, fingerprint, approvedAt }) => (
        <SettingsRow
          key={origin}
          label={<code className="settings-origin">{origin}</code>}
          description={
            <span title={`SHA-256 ${certificateFingerprintHex(fingerprint)}`}>
              {`Untrusted certificate allowed ${new Date(approvedAt).toLocaleDateString()}, SHA-256 ${certificateFingerprintHex(fingerprint).slice(0, 23)}…`}
            </span>
          }
          control={
            <RemoveButton
              label={`Remove the certificate for ${origin}`}
              onRemove={() =>
                void window.api.browserNetwork
                  .revokeCertificate(origin)
                  .then(setCertificates)
                  .catch(() => undefined)
              }
            />
          }
        />
      ))}
      {!approvals?.length && !certificates?.length && (
        <SettingsEmptyState compact icon={Network} title={loaded ? 'None yet.' : 'Loading…'} />
      )}
    </SettingsSection>
  )
}
