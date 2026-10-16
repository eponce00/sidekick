import { useEffect, useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import type { CommandLineToolStatus } from '../../../shared/commandLineTool'
import { SettingsRow, SettingsSection } from './SettingsLayout'

function summary(status: CommandLineToolStatus): string {
  if (status.mode === 'development') return 'Development build'
  if (status.mode === 'unavailable') return 'Not available in this package'
  if (!status.installed) return 'Not installed'
  return status.onPath === false
    ? `Installed at ${status.location}, but not on PATH`
    : `Installed at ${status.location}`
}

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

  return (
    <SettingsSection
      icon={SquareTerminal}
      title="Command line"
      description="Configure SideKick from a terminal or another agent. The command never prints an API key."
    >
      <SettingsRow
        label="sidekick command"
        description={status ? `${summary(status)}. ${status.hint}` : 'Checking…'}
        control={
          status?.mode === 'shell-script' ? (
            <button
              type="button"
              className="settings-secondary-action is-small"
              onClick={() => void install()}
              disabled={installing}
            >
              {installing ? 'Installing…' : status.installed ? 'Reinstall' : 'Install command'}
            </button>
          ) : undefined
        }
      >
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </SettingsRow>
    </SettingsSection>
  )
}
