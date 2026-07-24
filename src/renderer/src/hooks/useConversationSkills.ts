import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { getPersistentSkillIds } from '../skills'

export function useConversationSkills(conversationId: string | null): {
  activeSkillIds: string[]
  setActiveSkillIds: Dispatch<SetStateAction<string[]>>
} {
  const [activeSkillIds, setActiveSkillIdsState] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    if (!conversationId) {
      queueMicrotask(() => {
        if (!cancelled) setActiveSkillIdsState([])
      })
      return () => {
        cancelled = true
      }
    }
    window.api.conversations.loadSkills(conversationId).then((saved) => {
      if (cancelled) return
      const persistent = getPersistentSkillIds(saved ?? [])
      setActiveSkillIdsState(persistent)
      if (saved && persistent.length !== saved.length) {
        void window.api.conversations.saveSkills(conversationId, persistent)
      }
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const setActiveSkillIds = useCallback<Dispatch<SetStateAction<string[]>>>(
    (update) => {
      setActiveSkillIdsState((previous) => {
        const requested = typeof update === 'function' ? update(previous) : update
        const next = getPersistentSkillIds(requested)
        if (conversationId && next !== previous) {
          void window.api.conversations.saveSkills(conversationId, next)
        }
        return next
      })
    },
    [conversationId]
  )

  return { activeSkillIds, setActiveSkillIds }
}
