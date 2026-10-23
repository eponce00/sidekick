import { useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Message } from '../types/chat.types'

interface ConversationMessagesOptions {
  conversationId: string | null
  rollbackHash?: string | null
  onRollbackConsumed?: () => void
  onCostUpdate?: (totalCost: number) => void
}

export function useConversationMessages({
  conversationId,
  rollbackHash,
  onRollbackConsumed,
  onCostUpdate
}: ConversationMessagesOptions): {
  messages: Message[]
  setMessages: Dispatch<SetStateAction<Message[]>>
  messagesRef: MutableRefObject<Message[]>
  skipNextLoadRef: MutableRefObject<boolean>
} {
  const [messages, setMessages] = useState<Message[]>([])
  const messagesRef = useRef<Message[]>([])
  const skipNextLoadRef = useRef(false)
  const consumedRollbackRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!conversationId) {
      queueMicrotask(() => {
        if (!cancelled) setMessages([])
      })
      return () => {
        cancelled = true
      }
    }
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false
      return () => {
        cancelled = true
      }
    }

    window.api.conversations
      .getMessages(conversationId)
      .then((loadedMessages) => {
        if (!cancelled) setMessages(loadedMessages as Message[])
      })
      .catch((error) => console.error('Error loading messages:', error))
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // A message sent from the user's phone is saved by the main process; show it here too.
  useEffect(() => {
    if (!conversationId) return undefined
    let cancelled = false
    const unsubscribe = window.api.conversations.onMessagesChanged((changed) => {
      if (changed !== conversationId) return
      void window.api.conversations
        .getMessages(conversationId)
        .then((loadedMessages) => {
          if (cancelled) return
          const loaded = loadedMessages as Message[]
          const saved = new Set(loaded.map((message) => message.id))
          // A reply the window follows live is not saved until its run ends; keep it.
          setMessages((previous) => [
            ...loaded,
            ...previous.filter((message) => message.runId && !saved.has(message.id))
          ])
        })
        .catch((error) => console.error('Error loading messages:', error))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [conversationId])

  useEffect(() => {
    messagesRef.current = messages
    const totalCost = messages.reduce((sum, message) => sum + (message.tokenUsage?.cost || 0), 0)
    onCostUpdate?.(totalCost)
  }, [messages, onCostUpdate])

  useEffect(() => {
    if (!rollbackHash || !conversationId || consumedRollbackRef.current === rollbackHash) return
    const index = messages.findIndex((message) => message.checkpointHash === rollbackHash)
    if (index < 0) return
    consumedRollbackRef.current = rollbackHash
    const timestamp = messages[index].timestamp
    queueMicrotask(() => setMessages((previous) => previous.slice(0, index + 1)))
    void window.api.conversations.deleteMessagesAfter(conversationId, timestamp)
    onRollbackConsumed?.()
  }, [conversationId, messages, onRollbackConsumed, rollbackHash])

  useEffect(() => {
    if (consumedRollbackRef.current !== rollbackHash) consumedRollbackRef.current = null
  }, [rollbackHash])

  return { messages, setMessages, messagesRef, skipNextLoadRef }
}
