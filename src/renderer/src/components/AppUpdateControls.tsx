import { useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, RefreshCw } from 'lucide-react'
import type { AppUpdateState } from '../../../shared/appUpdates'
import './AppUpdateControls.css'

function useAppUpdateState(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null)

  useEffect(() => {
    let active = true
    void window.api.appUpdates.getState().then((next) => {
      if (active) setState(next)
    })
    const unsubscribe = window.api.appUpdates.onState((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}

function updateStatus(state: AppUpdateState): string {
  switch (state.status) {
    case 'disabled':
      if (state.reason === 'development') return 'Release checks are available in packaged builds.'
      return 'Release checks are not available on this platform.'
    case 'checking':
      return 'Checking for releases…'
    case 'up-to-date':
      return 'SideKick is up to date.'
    case 'available':
      return `SideKick ${state.update.version} is available.`
    case 'downloading':
      return `Downloading SideKick ${state.update.version}… ${state.percent}%`
    case 'ready':
      return state.installMode === 'restart'
        ? `SideKick ${state.update.version} is ready. Only the app will restart.`
        : `SideKick ${state.update.version} downloaded and verified. Replace your AppImage to update.`
    case 'installing':
      return 'Preparing update…'
    case 'error':
      return `Update failed: ${state.message}`
    default:
      return `SideKick ${state.currentVersion}`
  }
}

function primaryAction(state: AppUpdateState): {
  label: string
  icon: typeof ExternalLink
  run: () => Promise<unknown>
} | null {
  if (state.status === 'ready') {
    return {
      label: state.installMode === 'restart' ? 'Restart and update' : 'Show downloaded update',
      icon: RefreshCw,
      run: () => window.api.appUpdates.install()
    }
  }
  if (state.status === 'available') {
    return {
      label: 'View release',
      icon: ExternalLink,
      run: () => window.api.appUpdates.openRelease()
    }
  }
  if (state.status === 'error') {
    return { label: 'Retry', icon: RefreshCw, run: () => window.api.appUpdates.check() }
  }
  return null
}

export function AppUpdateToast(): React.JSX.Element | null {
  const state = useAppUpdateState()
  const [dismissedCheck, setDismissedCheck] = useState<number | null>(null)
  useEffect(() => {
    if (state?.status !== 'up-to-date') return
    const timer = window.setTimeout(() => setDismissedCheck(state.checkedAt), 4_000)
    return () => window.clearTimeout(timer)
  }, [state])
  if (
    !state ||
    state.status === 'idle' ||
    state.status === 'checking' ||
    state.status === 'disabled' ||
    (state.status === 'up-to-date' && dismissedCheck === state.checkedAt)
  ) {
    return null
  }

  const action = primaryAction(state)
  return (
    <aside className={`app-update-toast is-${state.status}`} role="status" aria-live="polite">
      <div className="app-update-toast-copy">
        {state.status === 'error' && <AlertCircle size={15} aria-hidden="true" />}
        <span>{updateStatus(state)}</span>
      </div>
      {action && (
        <div className="app-update-actions">
          <button className="primary" type="button" onClick={() => void action.run()}>
            <action.icon size={14} aria-hidden="true" />
            {action.label}
          </button>
        </div>
      )}
      {state.status === 'error' && (
        <button type="button" onClick={() => void window.api.appUpdates.openRelease()}>
          View release
        </button>
      )}
    </aside>
  )
}

export function AppUpdateSettings(): React.JSX.Element {
  const state = useAppUpdateState()
  if (!state) return <div className="app-update-settings">Loading release status…</div>
  const action = primaryAction(state)
  const busy = ['checking', 'downloading', 'installing'].includes(state.status)

  return (
    <div className="app-update-settings">
      <div>
        <strong>SideKick {state.currentVersion}</strong>
        <span>{updateStatus(state)}</span>
      </div>
      <div className="app-update-settings-actions">
        {action ? (
          <button className="primary" type="button" onClick={() => void action.run()}>
            <action.icon size={14} aria-hidden="true" />
            {action.label}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || state.status === 'disabled'}
            onClick={() => void window.api.appUpdates.check()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {state.status === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
    </div>
  )
}
