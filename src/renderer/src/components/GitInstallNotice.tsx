import { useEffect, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import './GitInstallNotice.css'

type Stage = 'none' | 'missing' | 'installing' | 'elsewhere' | 'failed' | 'ready'

const READY_SHOWN_MS = 6_000

// Once per run of the app: not on every chat, but not gone for good either, as undo stays off without it.
let dismissed = false

/** Undo needs Git. Says so above the composer, and gets it for the user if they like. */
export default function GitInstallNotice(): React.JSX.Element | null {
  const [stage, setStage] = useState<Stage>('none')

  useEffect(() => {
    if (dismissed) return
    let live = true
    window.api.workspace
      .gitAvailable()
      .then((available) => {
        if (live && !available) setStage('missing')
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  // Installing happens in another window, so coming back is when to look.
  useEffect(() => {
    if (stage !== 'elsewhere') return
    const look = (): void => {
      window.api.workspace
        .gitAvailable(true)
        .then((available) => {
          if (available) setStage('ready')
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
  }, [stage])

  useEffect(() => {
    if (stage !== 'ready') return
    const timer = setTimeout(() => setStage('none'), READY_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [stage])

  if (stage === 'none') return null

  const install = (): void => {
    setStage('installing')
    window.api.workspace
      .installGit()
      .then(({ outcome }) =>
        setStage(
          outcome === 'ready'
            ? 'ready'
            : outcome === 'declined'
              ? 'missing'
              : outcome === 'elsewhere'
                ? 'elsewhere'
                : 'failed'
        )
      )
      .catch(() => setStage('failed'))
  }

  return (
    <div className="git-notice" role="status">
      {stage === 'installing' && <Loader2 size={14} className="icon-spin" aria-hidden="true" />}
      {stage === 'ready' && <Check size={14} className="git-notice-ready" aria-hidden="true" />}
      <span className="git-notice-text">
        {stage === 'missing' && 'Undoing file changes needs Git, which isn’t installed.'}
        {stage === 'installing' && 'Installing Git. This usually takes about a minute.'}
        {stage === 'elsewhere' &&
          'Finish installing Git where it opened. Undo works once it’s done.'}
        {stage === 'failed' && 'Git didn’t install. You can get it from its download page.'}
        {stage === 'ready' && 'Git is ready, so file changes can be undone from now on.'}
      </span>
      {stage === 'missing' && (
        <button type="button" className="git-notice-action" onClick={install}>
          Install Git
        </button>
      )}
      {stage === 'failed' && (
        <a
          className="git-notice-action"
          href="https://git-scm.com/downloads"
          target="_blank"
          rel="noreferrer"
        >
          Download Git
        </a>
      )}
      {stage !== 'installing' && (
        <button
          type="button"
          className="git-notice-close"
          aria-label="Dismiss"
          onClick={() => {
            dismissed = true
            setStage('none')
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
