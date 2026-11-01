import { useCallback, useEffect, useState } from 'react'
import type { ChromeUseStatus } from '../../../shared/computerUse'
import { SettingsRow } from './SettingsLayout'

/**
 * Whether Chrome is connected, and the one button that sets it up, which asks in SideKick's dialog.
 * Turning the switch on isn't enough by itself, so until it is set up this says so plainly.
 */
export function ChromeUseSetup({ saved }: { saved: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<ChromeUseStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.api.chromeUse.status().then(setStatus)
  }, [])

  useEffect(refresh, [refresh])

  const setUp = (): void => {
    setBusy(true)
    void window.api.chromeUse.setUp().finally(() => {
      setBusy(false)
      refresh()
    })
  }

  if (status && !status.installed && !status.connected) {
    return (
      <SettingsRow
        className="settings-chrome-needed"
        image={status.iconDataUrl}
        label="One more step: set up Chrome"
        description="The agent can't work in Chrome until SideKick's extension is in it. SideKick adds it for you, in about 10 seconds."
        control={
          <button type="button" className="settings-primary-action" disabled={busy} onClick={setUp}>
            {busy ? 'Setting up…' : 'Set up Chrome'}
          </button>
        }
      />
    )
  }

  const profile = status?.profile
  return (
    <SettingsRow
      image={status?.iconDataUrl}
      label="Google Chrome"
      description={
        <span className="settings-chrome-status">
          {profile &&
            (profile.pictureDataUrl ? (
              <img className="settings-chrome-avatar" src={profile.pictureDataUrl} alt="" />
            ) : (
              <span
                className="settings-chrome-avatar"
                style={profile.color ? { background: profile.color } : undefined}
                aria-hidden="true"
              >
                {profile.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          {profile && <span>{profile.name}</span>}
          <span className={`settings-chrome-state${status?.connected ? ' is-connected' : ''}`}>
            {status?.connected ? 'Connected' : 'Connects when Chrome is open'}
          </span>
          {/* Set up, but the switch beside it still only lives in this form. */}
          {!saved && <span>Press Save changes to finish.</span>}
        </span>
      }
      control={
        <span className="settings-chrome-actions">
          {/* Once it's connected there's nothing to set up, and a dead button only looks broken. */}
          {!status?.connected && (
            <button
              type="button"
              className="settings-ghost-action is-small"
              disabled={busy}
              onClick={setUp}
            >
              {busy ? 'Setting up…' : 'Set up again'}
            </button>
          )}
          <button
            type="button"
            className="settings-ghost-action is-small"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.api.chromeUse.disconnect().finally(() => {
                setBusy(false)
                refresh()
              })
            }}
          >
            Disconnect
          </button>
        </span>
      }
    />
  )
}
