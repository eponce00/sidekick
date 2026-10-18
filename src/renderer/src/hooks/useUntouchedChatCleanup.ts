import { useEffect, useLayoutEffect, useRef } from 'react'
import { isEmptyComposerDraft, loadComposerDraft } from '../services/composerDrafts'
import type { Conversation } from '../types/app.types'

/** Long enough for a draft typed just before leaving to be saved (useComposerDraft). */
const LEAVE_SETTLE_MS = 600

/**
 * A chat opened and left with nothing in it does not stay behind in the sidebar, as in Claude and
 * Codex: leaving it, or finding it from an earlier session at startup, removes it. Something typed
 * in its message box keeps it, and main removes only a chat nothing has touched.
 */
export function useUntouchedChatCleanup({
  ready,
  conversations,
  currentConversationId,
  onDiscarded
}: {
  ready: boolean
  conversations: Conversation[]
  currentConversationId: string | null
  onDiscarded: (conversationId: string) => void
}): void {
  const latest = useRef({ conversations, currentConversationId, onDiscarded })
  useLayoutEffect(() => {
    latest.current = { conversations, currentConversationId, onDiscarded }
  })

  const discardIfUntouched = useRef(async (conversationId: string): Promise<void> => {
    const conversation = latest.current.conversations.find(({ id }) => id === conversationId)
    if (conversation?.title_source !== 'placeholder') return
    if (latest.current.currentConversationId === conversationId) return
    if (!isEmptyComposerDraft(loadComposerDraft(conversationId))) return
    try {
      const { discarded } = await window.api.conversations.discardIfUntouched(conversationId)
      if (discarded) latest.current.onDiscarded(conversationId)
    } catch (error) {
      console.warn('[Chats] An unused chat could not be cleared:', error)
    }
  })

  const previous = useRef(currentConversationId)
  useEffect(() => {
    const left = previous.current
    previous.current = currentConversationId
    if (!left || left === currentConversationId) return
    // Not cancelled by a further switch: each chat left is looked at once.
    window.setTimeout(() => void discardIfUntouched.current(left), LEAVE_SETTLE_MS)
  }, [currentConversationId])

  const swept = useRef(false)
  useEffect(() => {
    if (!ready || swept.current) return
    swept.current = true
    for (const { id, title_source } of conversations) {
      if (title_source === 'placeholder') void discardIfUntouched.current(id)
    }
  }, [conversations, ready])
}
