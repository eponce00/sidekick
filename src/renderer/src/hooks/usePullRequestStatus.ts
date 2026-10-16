import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullRequestStatus } from '../../../shared/pullRequests'

export const PULL_REQUEST_POLL_MS = 30_000

/**
 * Polls the main process for a folder's pull request while the window is visible: on an
 * interval, when the window regains focus, and on demand. Errors before the first successful
 * read stay hidden, since the folder may simply not be a GitHub repository.
 */
export function usePullRequestStatus(workspaceRoot: string): {
  status: PullRequestStatus | null
  error: string | null
  loading: boolean
  refresh: () => void
  dismissError: () => void
} {
  const [status, setStatus] = useState<PullRequestStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const refreshRef = useRef<() => void>(() => undefined)
  const loadedRef = useRef(false)
  const dismissedRef = useRef(false)

  useEffect(() => {
    let disposed = false
    let inFlight = false
    const update = async (): Promise<void> => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      setLoading(true)
      try {
        const result = await window.api.pullRequests.getStatus(workspaceRoot)
        if (disposed) return
        if (result.ok) {
          loadedRef.current = result.status !== null
          dismissedRef.current = false
          setStatus(result.status)
          setError(null)
        } else if (loadedRef.current && !dismissedRef.current) {
          setError(result.error)
        }
      } catch {
        if (!disposed && loadedRef.current && !dismissedRef.current) {
          setError('Could not load pull request status.')
        }
      } finally {
        inFlight = false
        if (!disposed) setLoading(false)
      }
    }
    refreshRef.current = () => void update()
    void update()
    const timer = window.setInterval(() => void update(), PULL_REQUEST_POLL_MS)
    const onFocus = (): void => void update()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [workspaceRoot])

  const refresh = useCallback(() => refreshRef.current(), [])
  const dismissError = useCallback(() => {
    dismissedRef.current = true
    setError(null)
  }, [])
  return { status, error, loading, refresh, dismissError }
}
