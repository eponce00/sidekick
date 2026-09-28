import { useEffect, useRef } from 'react'
import {
  NEW_CHAT_DRAFT_KEY,
  deleteComposerDraft,
  saveComposerDraft,
  type ComposerDraft
} from '../services/composerDrafts'

const SAVE_DELAY_MS = 300

export function composerDraftKey(conversationId: string | null): string {
  return conversationId ?? NEW_CHAT_DRAFT_KEY
}

/**
 * Keeps the composer's unsent text and attachments in storage for this chat.
 * Writes are debounced while typing and flushed when the panel unmounts or
 * the window closes, so switching chats right after typing loses nothing.
 * Sending clears the box, and an empty draft removes the stored one.
 */
export function useComposerDraft(conversationId: string | null, draft: ComposerDraft): void {
  const key = composerDraftKey(conversationId)
  const latestRef = useRef({ key, draft })
  // Only an unsaved change is flushed, so closing a chat that was just
  // deleted does not write its draft back.
  const pendingRef = useRef(false)
  const { text, images, attachments } = draft

  useEffect(() => {
    latestRef.current = { key, draft: { text, images, attachments } }
    pendingRef.current = true
    const timer = window.setTimeout(() => {
      pendingRef.current = false
      saveComposerDraft(key, { text, images, attachments })
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [key, text, images, attachments])

  // A new chat gets its id when its first message is sent, so the shared
  // new-chat draft has been used up.
  const previousKeyRef = useRef(key)
  useEffect(() => {
    if (previousKeyRef.current === NEW_CHAT_DRAFT_KEY && key !== NEW_CHAT_DRAFT_KEY) {
      deleteComposerDraft(NEW_CHAT_DRAFT_KEY)
    }
    previousKeyRef.current = key
  }, [key])

  useEffect(() => {
    const flush = (): void => {
      if (!pendingRef.current) return
      pendingRef.current = false
      saveComposerDraft(latestRef.current.key, latestRef.current.draft)
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])
}
