import { useEffect, useState } from 'react'
import type { ComputerRememberedApp } from '../../../shared/computerUse'
import { SettingsRow } from './SettingsLayout'

/** The apps chosen with Always allow. Adding one only ever happens in SideKick's own dialog. */
export function ComputerUseAllowedApps(): React.JSX.Element | null {
  const [apps, setApps] = useState<ComputerRememberedApp[]>([])

  useEffect(() => {
    let current = true
    void window.api.computerUse.rememberedApps().then((list) => {
      if (current) setApps(list)
    })
    return () => {
      current = false
    }
  }, [])

  if (apps.length === 0) return null
  return (
    <>
      {apps.map((app) => (
        <SettingsRow
          key={app.path}
          image={app.iconDataUrl}
          label={app.name}
          description={
            <span className="settings-app-path" title={app.path}>
              {app.path}
            </span>
          }
          control={
            <button
              type="button"
              className="settings-ghost-action is-small"
              onClick={() => {
                void window.api.computerUse
                  .forgetApp(app.path)
                  .then(() => setApps((list) => list.filter((item) => item.path !== app.path)))
              }}
            >
              Remove
            </button>
          }
        />
      ))}
    </>
  )
}
