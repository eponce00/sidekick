import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation } from '../types/app.types'

const RUN_RELEASE_DELAY_MS = 150

export interface ConversationPanelRegistry {
  busyConversationIds: ReadonlySet<string>
  currentConversationIdRef: React.MutableRefObject<string | null>
  currentConversationBusy: boolean
  hasActiveConversationRuns: boolean
  mountedConversationIds: string[]
  conversationPanelKeys: Readonly<Record<string, string>>
  draftPanelKey: string
  onBusyStateChange: (conversationId: string | null, busy: boolean) => void
  claimDraftPanel: (conversationId: string) => void
  forgetPanel: (conversationId: string) => void
  resetPanels: () => void
}

/**
 * Keeps one mounted controller per running conversation. A short release delay
 * preserves the controller across queue/pivot hand-offs, where one run finishes
 * immediately before its queued successor begins.
 */
export function useConversationPanelRegistry(
  conversations: Conversation[],
  currentConversationId: string | null
): ConversationPanelRegistry {
  const [busyConversationIds, setBusyConversationIds] = useState<Set<string>>(() => new Set())
  const [conversationPanelKeys, setConversationPanelKeys] = useState<Record<string, string>>({})
  const [draftPanelKey, setDraftPanelKey] = useState(() => `draft:${crypto.randomUUID()}`)
  const releaseTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const currentConversationIdRef = useRef<string | null>(currentConversationId)

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId
  }, [currentConversationId])

  const onBusyStateChange = useCallback((conversationId: string | null, busy: boolean): void => {
    if (!conversationId) return
    const pendingRelease = releaseTimersRef.current.get(conversationId)
    if (pendingRelease) {
      clearTimeout(pendingRelease)
      releaseTimersRef.current.delete(conversationId)
    }
    if (busy) {
      setBusyConversationIds((current) => {
        if (current.has(conversationId)) return current
        return new Set(current).add(conversationId)
      })
      return
    }
    const timer = setTimeout(() => {
      releaseTimersRef.current.delete(conversationId)
      setBusyConversationIds((current) => {
        if (!current.has(conversationId)) return current
        const next = new Set(current)
        next.delete(conversationId)
        return next
      })
    }, RUN_RELEASE_DELAY_MS)
    releaseTimersRef.current.set(conversationId, timer)
  }, [])

  const claimDraftPanel = useCallback(
    (conversationId: string): void => {
      setConversationPanelKeys((current) => ({ ...current, [conversationId]: draftPanelKey }))
      setDraftPanelKey(`draft:${crypto.randomUUID()}`)
    },
    [draftPanelKey]
  )

  const forgetPanel = useCallback((conversationId: string): void => {
    const pendingRelease = releaseTimersRef.current.get(conversationId)
    if (pendingRelease) clearTimeout(pendingRelease)
    releaseTimersRef.current.delete(conversationId)
    setBusyConversationIds((current) => {
      if (!current.has(conversationId)) return current
      const next = new Set(current)
      next.delete(conversationId)
      return next
    })
    setConversationPanelKeys((current) => {
      if (!(conversationId in current)) return current
      const next = { ...current }
      delete next[conversationId]
      return next
    })
  }, [])

  const resetPanels = useCallback((): void => {
    for (const timer of releaseTimersRef.current.values()) clearTimeout(timer)
    releaseTimersRef.current.clear()
    setBusyConversationIds(new Set())
    setConversationPanelKeys({})
  }, [])

  useEffect(
    () => () => {
      for (const timer of releaseTimersRef.current.values()) clearTimeout(timer)
      releaseTimersRef.current.clear()
    },
    []
  )

  const mountedConversationIds = useMemo(() => {
    const knownIds = new Set(conversations.map(({ id }) => id))
    const ids: string[] = []
    if (currentConversationId && knownIds.has(currentConversationId))
      ids.push(currentConversationId)
    for (const id of busyConversationIds) {
      if (knownIds.has(id) && !ids.includes(id)) ids.push(id)
    }
    return ids
  }, [busyConversationIds, conversations, currentConversationId])

  return {
    busyConversationIds,
    currentConversationIdRef,
    currentConversationBusy: Boolean(
      currentConversationId && busyConversationIds.has(currentConversationId)
    ),
    hasActiveConversationRuns: busyConversationIds.size > 0,
    mountedConversationIds,
    conversationPanelKeys,
    draftPanelKey,
    onBusyStateChange,
    claimDraftPanel,
    forgetPanel,
    resetPanels
  }
}
