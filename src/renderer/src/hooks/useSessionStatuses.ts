import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationAttentionAlert } from '../../../shared/conversationAttention'
import { sessionIsActive, type SessionStatus } from '../../../shared/sessions'

export interface SessionStatuses {
  /** Every chat that is not idle, by id. */
  byId: ReadonlyMap<string, SessionStatus>
  /** Chats with a run queued, working, or paused on the user. */
  active: ReadonlySet<string>
  /** Chats paused on an approval or a question. */
  waiting: ReadonlySet<string>
}

/**
 * Each chat's state as the main process computes it, so a run started without a chat panel,
 * by a schedule or another chat, shows the same as one started here. `onAlert` fires when a
 * chat starts waiting on the user or its run fails.
 */
export function useSessionStatuses(
  onAlert: (alert: ConversationAttentionAlert) => void
): SessionStatuses {
  const [byId, setById] = useState<ReadonlyMap<string, SessionStatus>>(() => new Map())
  const onAlertRef = useRef(onAlert)
  useEffect(() => {
    onAlertRef.current = onAlert
  }, [onAlert])

  useEffect(() => {
    let live = true
    // A change that arrives before the initial read is newer than it, for the chats it names.
    const changedBeforeLoad = new Map<string, SessionStatus>()
    let loaded = false
    const unsubscribe = window.api.sessions.onChanged((change) => {
      if (change.kind !== 'status') return
      for (const alert of change.alerts ?? []) onAlertRef.current(alert)
      if (!change.statuses?.length) return
      if (!loaded)
        for (const status of change.statuses) changedBeforeLoad.set(status.conversationId, status)
      setById((current) => {
        const next = new Map(current)
        for (const status of change.statuses ?? []) {
          if (status.state === 'idle' && !status.family) next.delete(status.conversationId)
          else next.set(status.conversationId, status)
        }
        return next
      })
    })
    void window.api.sessions
      .statuses()
      .then((statuses) => {
        if (!live) return
        loaded = true
        const next = new Map(statuses.map((status) => [status.conversationId, status]))
        for (const [id, status] of changedBeforeLoad) {
          if (status.state === 'idle' && !status.family) next.delete(id)
          else next.set(id, status)
        }
        setById(next)
      })
      .catch((error) => console.warn('[Sessions] Could not read chat status:', error))
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return useMemo(() => {
    const active = new Set<string>()
    const waiting = new Set<string>()
    for (const status of byId.values()) {
      if (sessionIsActive(status.state)) active.add(status.conversationId)
      if (status.state === 'waiting') waiting.add(status.conversationId)
    }
    return { byId, active, waiting }
  }, [byId])
}
