import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Copy, Pencil, RotateCcw, Volume2 } from 'lucide-react'
import { MessageItem } from '../components/MessageItem'
import { speechPlayer } from '../services/voice/speechPlayer'
import type { Message } from '../types/chat.types'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { phoneNotice } from './phoneApi'
import { useCompanionVoice } from './phoneVoice'
import { copyFormatted } from './richCopy'
import { Sheet, SheetAction } from './Sheet'

type Resolve = (
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
) => Promise<void>

const NOTHING = (): void => undefined
const WAIT_FOR_RUN = 'Wait for SideKick to finish, or stop it first.'

/** The sent message a tap landed on, unless it landed on something of its own, such as a photo. */
function tappedUserMessage(event: MouseEvent): string | null {
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('button, a, summary, .message-footer-popover')) return null
  return target.closest('.message-user[data-message-id]')?.getAttribute('data-message-id') ?? null
}

/**
 * The chat drawn by the desktop's own message view, so replies, tools, cards and footers look and
 * work as they do there. A reply keeps its row of buttons in view, as there is no pointer to bring
 * it up. A sent message opens its actions (copy, read aloud, edit, retry) in a sheet when tapped,
 * as the phone apps do, so nothing in the chat moves. Forking and rewinding stay on the computer.
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
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Message | null>(null)
  const voice = useCompanionVoice()
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

  // A reply's own Retry, shown when its run stopped short, asks first as the sheet's does.
  const askRetry = useCallback(
    (message: Message) => {
      if (runActive) return phoneNotice(WAIT_FOR_RUN)
      setRetrying(message)
    },
    [runActive]
  )
  const closeMenu = useCallback(() => setMenuFor(null), [])
  const closeRetry = useCallback(() => setRetrying(null), [])
  const menuMessage = menuFor ? messages.find((message) => message.id === menuFor) : undefined

  const last = messages.length - 1
  return (
    <div
      className="cp-transcript"
      onClick={(event) => {
        const id = tappedUserMessage(event)
        if (id) setMenuFor(id)
      }}
    >
      {messages.map((message, index) => (
        <div
          key={message.id}
          className={`cp-message-slot${menuFor === message.id ? ' is-selected' : ''}`}
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
            onEditMessage={NOTHING}
            onCopyMessage={copyMessage}
            onRetryMessage={askRetry}
            onApproveToolLimitDecision={(id) => void onResolve(id, { approved: true })}
            onDenyToolLimitDecision={(id) => void onResolve(id, { approved: false })}
            onResolveAgentInteraction={onResolve}
          />
        </div>
      ))}
      {menuMessage && (
        <Sheet label="Message" onClose={closeMenu}>
          <p className="cp-sheet-quote">{menuMessage.content}</p>
          <SheetAction
            icon={<Copy size={20} />}
            label="Copy"
            onClick={() => {
              setMenuFor(null)
              void copyFormatted(messageTextForClipboard(menuMessage)).then(
                (copied) => copied && phoneNotice('Copied')
              )
            }}
          />
          {voice?.speech && (
            <SheetAction
              icon={<Volume2 size={20} />}
              label="Read aloud"
              onClick={() => {
                setMenuFor(null)
                void speechPlayer
                  .toggle(menuMessage.id, menuMessage.content)
                  .then((problem) => problem && phoneNotice(problem))
              }}
            />
          )}
          <SheetAction
            icon={<Pencil size={20} />}
            label="Edit"
            description="Change it and send it again"
            onClick={() => {
              setMenuFor(null)
              if (runActive) phoneNotice(WAIT_FOR_RUN)
              else onEdit(menuMessage)
            }}
          />
          <SheetAction
            icon={<RotateCcw size={20} />}
            label="Retry"
            description="Answer it again: later replies leave, and file changes since are put back"
            onClick={() => {
              setMenuFor(null)
              if (runActive) phoneNotice(WAIT_FOR_RUN)
              else onRetry(menuMessage)
            }}
          />
        </Sheet>
      )}
      {retrying && (
        <Sheet label="Retry" onClose={closeRetry}>
          <p className="cp-sheet-note">
            SideKick answers this again. The replies after it leave the chat, and the files it
            changed since are put back.
          </p>
          <SheetAction
            icon={<RotateCcw size={20} />}
            label="Answer again"
            onClick={() => {
              setRetrying(null)
              onRetry(retrying)
            }}
          />
        </Sheet>
      )}
    </div>
  )
}
