import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Copy } from 'lucide-react'
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
const RETRY_ON_COMPUTER = 'Retry this reply on the computer.'
/** How long a finger rests on a sent message before its menu opens. */
const LONG_PRESS_MS = 450

/** The sent message under an event, by the id the desktop's message view puts on each one. */
function userMessageId(event: SyntheticEvent): string | null {
  const target = event.target instanceof Element ? event.target : null
  const message = target?.closest('.message-user[data-message-id]')
  return message?.getAttribute('data-message-id') ?? null
}

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

  // A reply is copied as it reads, formatted, rather than as the Markdown it was written in.
  const copyMessage = useCallback((message: Message) => {
    void copyFormatted(messageTextForClipboard(message)).then((copied) => {
      if (!copied) return
      setCopiedMessageId(message.id)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedMessageId(null), 2_000)
    })
  }, [])

  // A sent message has no row of buttons under it, as in the phone apps: holding it opens a menu.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const cancelPress = (): void => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancelPress, [])
  const closeMenu = useCallback(() => setMenuFor(null), [])
  const menuMessage = menuFor ? messages.find((message) => message.id === menuFor) : undefined

  const last = messages.length - 1
  return (
    <div
      className="cp-transcript"
      onContextMenu={(event) => {
        const id = userMessageId(event)
        if (!id) return
        event.preventDefault()
        cancelPress()
        setMenuFor(id)
      }}
      onTouchStart={(event) => {
        const id = userMessageId(event)
        cancelPress()
        if (!id || event.touches.length !== 1) return
        const { clientX: x, clientY: y } = event.touches[0]
        press.current = { x, y, timer: setTimeout(() => setMenuFor(id), LONG_PRESS_MS) }
      }}
      onTouchMove={(event) => {
        const start = press.current
        const touch = event.touches[0]
        if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10)
          cancelPress()
      }}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
    >
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
      {menuMessage && (
        <Sheet label="Message" onClose={closeMenu}>
          <p className="cp-sheet-quote">{menuMessage.content}</p>
          <SheetAction
            icon={<Copy size={18} />}
            label="Copy"
            onClick={() => {
              setMenuFor(null)
              void copyFormatted(messageTextForClipboard(menuMessage)).then(
                (copied) => copied && phoneNotice('Copied')
              )
            }}
          />
        </Sheet>
      )}
    </div>
  )
}
