import { useEffect, useRef, useState } from 'react'
import type { ConversationAttentionAlert } from '../../../shared/conversationAttention'

/**
 * The conversations whose agent is paused on the user, as the main process
 * tracks them. `onAlert` fires when one starts waiting or a run fails.
 */
export function useConversationAttention(
  onAlert: (alert: ConversationAttentionAlert) => void
): ReadonlySet<string> {
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set())
  const onAlertRef = useRef(onAlert)
  useEffect(() => {
    onAlertRef.current = onAlert
  }, [onAlert])

  useEffect(() => {
    let live = true
    // A change that arrives before the initial read is newer than it.
    let changed = false
    const unsubscribe = window.api.agentRuns.onAttention((state) => {
      changed = true
      setWaiting(new Set(state.waitingConversationIds))
      if (state.alert) onAlertRef.current(state.alert)
    })
    void window.api.agentRuns
      .attention()
      .then((state) => {
        if (live && !changed) setWaiting(new Set(state.waitingConversationIds))
      })
      .catch((error) => console.warn('[Attention] Could not read waiting conversations:', error))
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return waiting
}
