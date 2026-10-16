import { useEffect, useState } from 'react'
import type { CommandLineToolStatus } from '../../../shared/commandLineTool'

/** Shows how to reach the `sidekick` command and installs it where Settings can. */
export function CommandLineToolSettings(): React.JSX.Element {
  const [status, setStatus] = useState<CommandLineToolStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.commandLine.status().then((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
    }
  }, [])

  const install = async (): Promise<void> => {
    setInstalling(true)
    setError(null)
    const result = await window.api.commandLine.install()
    setStatus(result.status)
    if (!result.ok) setError(result.error)
    setInstalling(false)
  }

  if (!status) return <p className="support-export-status">Checking…</p>

  const summary =
    status.mode === 'development'
      ? 'Development build'
      : status.mode === 'unavailable'
        ? 'Not available in this package'
        : status.installed
          ? status.onPath === false
            ? `Installed at ${status.location}, but not on PATH`
            : `Installed at ${status.location}`
          : 'Not installed'

  return (
    <>
      <div className="support-export-row">
        <span>
          <strong>sidekick command</strong>
          <small>
            Lets you and other agents inspect and change these settings from a terminal. It never
            prints an API key.
          </small>
        </span>
        {status.mode === 'shell-script' && (
          <button
            type="button"
            className="settings-secondary-action"
            onClick={() => void install()}
            disabled={installing}
          >
            {installing ? 'Installing…' : status.installed ? 'Reinstall' : 'Install command'}
          </button>
        )}
      </div>
      <p
        className={`support-export-status ${error ? 'error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {error ?? `${summary}. ${status.hint}`}
      </p>
    </>
  )
}
