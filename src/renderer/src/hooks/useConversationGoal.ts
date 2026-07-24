import { useCallback, useEffect, useState } from 'react'
import type { ConversationGoal } from '../../../shared/conversationGoals'

export function useConversationGoal(conversationId: string | null): {
  goal: ConversationGoal | null
  createGoal: (targetConversationId: string, objective: string) => Promise<ConversationGoal>
  editGoal: (objective: string) => Promise<ConversationGoal>
  pauseGoal: () => Promise<ConversationGoal>
  resumeGoal: () => Promise<ConversationGoal>
  clearGoal: () => Promise<ConversationGoal>
} {
  const [goal, setGoal] = useState<ConversationGoal | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!conversationId) {
      return
    }
    void window.api.conversationGoals.current(conversationId).then((current) => {
      if (!cancelled) setGoal(current)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  useEffect(
    () =>
      window.api.conversationGoals.onChanged(({ goal: changed }) => {
        if (changed.conversationId !== conversationId) return
        setGoal(changed.status === 'cleared' ? null : changed)
      }),
    [conversationId]
  )

  const createGoal = useCallback(async (targetConversationId: string, objective: string) => {
    const created = await window.api.conversationGoals.create({
      conversationId: targetConversationId,
      objective
    })
    setGoal(created)
    return created
  }, [])

  const visibleGoal = goal?.conversationId === conversationId ? goal : null

  const requireGoal = useCallback((): ConversationGoal => {
    if (!visibleGoal) throw new Error('No goal is attached to this conversation')
    return visibleGoal
  }, [visibleGoal])

  const editGoal = useCallback(
    async (objective: string) => {
      const updated = await window.api.conversationGoals.edit({
        goalId: requireGoal().id,
        objective
      })
      setGoal(updated)
      return updated
    },
    [requireGoal]
  )

  const pauseGoal = useCallback(async () => {
    const updated = await window.api.conversationGoals.pause(requireGoal().id)
    setGoal(updated)
    return updated
  }, [requireGoal])

  const resumeGoal = useCallback(async () => {
    const updated = await window.api.conversationGoals.resume(requireGoal().id)
    setGoal(updated)
    return updated
  }, [requireGoal])

  const clearGoal = useCallback(async () => {
    const updated = await window.api.conversationGoals.clear(requireGoal().id)
    setGoal(null)
    return updated
  }, [requireGoal])

  return { goal: visibleGoal, createGoal, editGoal, pauseGoal, resumeGoal, clearGoal }
}
