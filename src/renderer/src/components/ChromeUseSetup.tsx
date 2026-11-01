import { useCallback, useEffect, useState } from 'react'
import type { ChromeUseStatus } from '../../../shared/computerUse'
import { SettingsRow } from './SettingsLayout'

/** Whether Chrome is connected, and the one button that sets it up, which asks in SideKick's dialog. */
export function ChromeUseSetup(): React.JSX.Element {
  const [status, setStatus] = useState<ChromeUseStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.api.chromeUse.status().then(setStatus)
  }, [])

  useEffect(refresh, [refresh])

  const profile = status?.profile
  return (
    <SettingsRow
      image={status?.iconDataUrl}
      label="Google Chrome"
      description={
        status?.installed ? (
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
            <span className={`settings-chrome-state${status.connected ? ' is-connected' : ''}`}>
              {status.connected ? 'Connected' : 'Connects when Chrome is open'}
            </span>
          </span>
        ) : (
          'Not set up yet. SideKick does this for you, in about 10 seconds.'
        )
      }
      control={
        <button
          type="button"
          className="settings-ghost-action is-small"
          disabled={busy || status?.connected === true}
          onClick={() => {
            setBusy(true)
            void window.api.chromeUse.setUp().finally(() => {
              setBusy(false)
              refresh()
            })
          }}
        >
          {busy ? 'Setting up…' : status?.installed ? 'Set up again' : 'Set up'}
        </button>
      }
    />
  )
}
