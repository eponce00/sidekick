import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import { MessageItem } from '../components/MessageItem'
import type { Message } from '../types/chat.types'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { phoneNotice } from './phoneApi'
import { copyFormatted } from './richCopy'
import { Sheet, SheetAction } from './Sheet'

type Resolve = (
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
) => Promise<void>

const NOTHING = (): void => undefined
const WAIT_FOR_RUN = 'Wait for SideKick to finish, or stop it first.'

/** The sent message a tap landed on, unless it landed on one of its buttons. */
function tappedUserMessage(event: MouseEvent): string | null {
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('button, a, .message-actions, .message-footer-popover')) return null
  return target.closest('.message-user[data-message-id]')?.getAttribute('data-message-id') ?? null
}

/**
 * The chat drawn by the desktop's own message view, so replies, tools, cards and footers look and
 * work as they do there. A reply keeps its row of buttons in view, as there is no pointer to bring
 * it up; a sent message shows its own (copy, read aloud, edit, retry) when tapped, as the phone
 * apps do. Forking and rewinding stay on the computer.
 */
export function Transcript({
  messages,
  runActive,
  editingMessageId,
  onResolve,
  onEdit,
  onRetry
}: {
  messages: readonly Message[]
  runActive: boolean
  /** The sent message being edited in the message box, which steps back as on the desktop. */
  editingMessageId: string | null
  onResolve: Resolve
  onEdit: (message: Message) => void
  onRetry: (message: Message) => void
}) {
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(() => new Set())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Message | null>(null)
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

  // A reply is copied as it reads, formatted, rather than as the Markdown it was written in.
  const copyMessage = useCallback((message: Message) => {
    void copyFormatted(messageTextForClipboard(message)).then((copied) => {
      if (!copied) return
      setCopiedMessageId(message.id)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedMessageId(null), 2_000)
    })
  }, [])

  const editMessage = useCallback(
    (message: Message) => {
      if (runActive) return phoneNotice(WAIT_FOR_RUN)
      setRevealed(null)
      onEdit(message)
    },
    [runActive, onEdit]
  )
  const askRetry = useCallback(
    (message: Message) => {
      if (runActive) return phoneNotice(WAIT_FOR_RUN)
      setRetrying(message)
    },
    [runActive]
  )
  const closeRetry = useCallback(() => setRetrying(null), [])

  const last = messages.length - 1
  return (
    <div
      className="cp-transcript"
      onClick={(event) => {
        const id = tappedUserMessage(event)
        if (id) setRevealed((current) => (current === id ? null : id))
      }}
    >
      {messages.map((message, index) => (
        <div
          key={message.id}
          className={`cp-message-slot${revealed === message.id ? ' is-revealed' : ''}`}
        >
          <MessageItem
            message={message}
            index={index}
            isLoading={runActive && index === last && message.role === 'agent'}
            expandedThinking={expandedThinking}
            editingMessageId={editingMessageId}
            copiedMessageId={copiedMessageId}
            onToggleThinking={toggleThinking}
            onHandleArtifactResult={NOTHING}
            onEditMessage={editMessage}
            onCopyMessage={copyMessage}
            onRetryMessage={askRetry}
            onApproveToolLimitDecision={(id) => void onResolve(id, { approved: true })}
            onDenyToolLimitDecision={(id) => void onResolve(id, { approved: false })}
            onResolveAgentInteraction={onResolve}
          />
        </div>
      ))}
      {retrying && (
        <Sheet label="Retry" onClose={closeRetry}>
          {retrying.role === 'user' && <p className="cp-sheet-quote">{retrying.content}</p>}
          <p className="cp-sheet-note">
            SideKick answers this message again. The replies after it leave the chat, and the files
            it changed since are put back.
          </p>
          <SheetAction
            icon={<RotateCcw size={18} />}
            label="Answer again"
            onClick={() => {
              setRetrying(null)
              setRevealed(null)
              onRetry(retrying)
            }}
          />
        </Sheet>
      )}
    </div>
  )
}
