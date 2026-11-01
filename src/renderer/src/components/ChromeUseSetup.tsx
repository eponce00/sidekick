import { useCallback, useEffect, useState } from 'react'
import { SettingsRow } from './SettingsLayout'

/** Whether Chrome is connected, and the one button that sets it up, which asks in SideKick's dialog. */
export function ChromeUseSetup(): React.JSX.Element {
  const [status, setStatus] = useState<{ connected: boolean; installed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.api.chromeUse.status().then(setStatus)
  }, [])

  useEffect(refresh, [refresh])

  return (
    <SettingsRow
      label="Your Chrome"
      description={
        status?.connected
          ? 'Connected.'
          : status?.installed
            ? 'Set up. It connects when Chrome is open.'
            : 'Not set up yet. SideKick does this for you, in about 10 seconds.'
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
