import { useEffect, useState } from 'react'
import type { SessionState } from '../../../shared/sessions'

const NO_STATUSES: ReadonlyMap<string, SessionState> = new Map()

/**
 * Each chat's session state from the main process, kept current from its change events. Chats
 * missing from the map are idle. Until the main process serves states the map stays empty, and
 * the sidebar falls back to what the renderer knows.
 */
export function useSessionStatuses(): ReadonlyMap<string, SessionState> {
  const [statuses, setStatuses] = useState(NO_STATUSES)
  useEffect(() => {
    const sessions = window.api?.sessions
    if (!sessions) return
    let cancelled = false
    sessions
      .statuses()
      .then((list) => {
        if (!cancelled)
          setStatuses(new Map(list.map((status) => [status.conversationId, status.state])))
      })
      .catch(() => undefined)
    const unsubscribe = sessions.onChanged((change) => {
      if (change.kind !== 'status' || !change.statuses) return
      setStatuses((current) => {
        const next = new Map(current)
        for (const id of change.conversationIds) next.delete(id)
        for (const status of change.statuses!) {
          if (status.state !== 'idle') next.set(status.conversationId, status.state)
        }
        return next
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return statuses
}
