import { useCallback, useEffect, useRef, useState } from 'react'
import type { Schedule } from '../../../shared/schedules'

/**
 * The schedules the main process owns, kept current from its change events, which also follow
 * each scheduled run's phase. `onConversationsChanged` hears when a scheduled run creates or
 * finishes a chat, so the conversation list can refresh.
 */
export function useSchedules(onConversationsChanged?: () => void): {
  schedules: Schedule[]
  refresh: () => Promise<void>
} {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const onChangedRef = useRef(onConversationsChanged)
  useEffect(() => {
    onChangedRef.current = onConversationsChanged
  }, [onConversationsChanged])

  const refresh = useCallback(async () => {
    setSchedules(await window.api.schedules.list())
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.schedules
      .list()
      .then((list) => {
        if (!cancelled) setSchedules(list)
      })
      .catch((error) => console.error('[Schedules] Could not load schedules', error))
    const unsubscribe = window.api.schedules.onChanged((change) => {
      setSchedules(change.schedules)
      if (change.conversationId) onChangedRef.current?.()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return { schedules, refresh }
}
