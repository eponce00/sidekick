import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageItem } from '../components/MessageItem'
import type { Message } from '../types/chat.types'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { copyOnPhone, phoneNotice } from './phoneApi'

type Resolve = (
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
) => Promise<void>

const NOTHING = (): void => undefined
const RETRY_ON_COMPUTER = 'Retry this reply on the computer.'

/**
 * The chat drawn by the desktop's own message view, so replies, tools, cards and footers look and
 * work as they do there. What changes the chat's history, such as editing, rewinding or forking,
 * stays on the computer, so the messages are shown read-only.
 */
export function Transcript({
  messages,
  runActive,
  onResolve
}: {
  messages: readonly Message[]
  runActive: boolean
  onResolve: Resolve
}) {
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(() => new Set())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const copyMessage = useCallback((message: Message) => {
    void copyOnPhone(messageTextForClipboard(message)).then((copied) => {
      if (!copied) return
      setCopiedMessageId(message.id)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedMessageId(null), 2_000)
    })
  }, [])

  const last = messages.length - 1
  return (
    <>
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          index={index}
          isLoading={runActive && index === last && message.role === 'agent'}
          expandedThinking={expandedThinking}
          editingMessageId={null}
          copiedMessageId={copiedMessageId}
          onToggleThinking={toggleThinking}
          onHandleArtifactResult={NOTHING}
          onEditMessage={NOTHING}
          onCopyMessage={copyMessage}
          onRetryMessage={() => phoneNotice(RETRY_ON_COMPUTER)}
          onApproveToolLimitDecision={(id) => void onResolve(id, { approved: true })}
          onDenyToolLimitDecision={(id) => void onResolve(id, { approved: false })}
          onResolveAgentInteraction={onResolve}
          readOnly
        />
      ))}
    </>
  )
}
