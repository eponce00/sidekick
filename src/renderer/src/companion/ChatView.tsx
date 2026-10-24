import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, EllipsisVertical, Loader2, Menu, SquarePen } from 'lucide-react'
import type { CompanionChat, CompanionProject } from '../../../shared/companion'
import { ChatMenu } from './ChatMenu'
import type { CompanionConnection } from './chatState'
import { FindBar } from './FindBar'
import type { HomeSuggestion } from './homeSuggestions'
import { PhoneChatSurface } from './PhoneChatSurface'
import { PhoneComposer } from './PhoneComposer'
import { Robot } from './Robot'
import { StartInBar, type StartIn } from './StartInBar'
import { Transcript } from './Transcript'
import { useCompanionChat, type Subscribe } from './useCompanionChat'

/**
 * One chat, or with no chat the new-chat home. As in the ChatGPT app, its buttons float over the
 * chat, which scrolls under them: the drawer's on the left, and on the right a new chat and the
 * chat's menu, which names it and holds what can be done to it.
 */
export function ChatView({
  connection,
  conversationId,
  fallbackTitle,
  subscribe,
  reconnects,
  suggestions,
  projects,
  startIn,
  onMenu,
  onNew,
  onOpenChat,
  onCreated,
  onFailure
}: {
  connection: CompanionConnection
  conversationId: string | null
  /** The drawer's title while the chat loads. */
  fallbackTitle: string
  subscribe: Subscribe
  reconnects: number
  /** What the new-chat home offers. */
  suggestions: readonly HomeSuggestion[]
  projects: readonly CompanionProject[]
  /** For the new-chat home: the project it starts in. */
  startIn: string | null
  onMenu: () => void
  onNew: () => void
  onOpenChat: (chat: CompanionChat) => void
  onCreated: (conversationId: string) => void
  onFailure: (error: unknown) => string | null
}) {
  const chat = useCompanionChat({
    connection,
    initialConversationId: conversationId,
    subscribe,
    reconnects,
    onCreated,
    onFailure
  })
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [where, setWhere] = useState<StartIn>({ projectId: startIn, workIn: 'folder' })
  // The sent message being edited in the message box.
  const [editing, setEditing] = useState<{
    messageId: string
    text: string
    nonce: number
    source: HTMLElement | null
  } | null>(null)
  // The ⋮ button while its menu is open.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [finding, setFinding] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Follows new output while the reader is at the bottom, and leaves them alone once they scroll up.
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [chat.messages, chat.error, chat.queue])

  const home = !chat.conversationId
  const empty = !chat.loading && !chat.messages.length
  const shownChat = chat.chat ? { ...chat.chat, title: chat.chat.title || fallbackTitle } : null
  return (
    <div className="cp-screen">
      {finding ? (
        <header className="cp-topbar is-finding">
          <FindBar containerRef={scroller} onClose={() => setFinding(false)} />
        </header>
      ) : (
        <header className="cp-topbar">
          <button type="button" className="cp-float-button" aria-label="Chats" onClick={onMenu}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="cp-float-group">
            <button
              type="button"
              className="cp-float-group-button"
              aria-label="New chat"
              disabled={home && empty}
              onClick={onNew}
            >
              <SquarePen size={19} aria-hidden="true" />
            </button>
            {shownChat && (
              <button
                type="button"
                className="cp-float-group-button"
                aria-label="Chat options"
                aria-haspopup="menu"
                aria-expanded={menuAnchor !== null}
                onClick={(event) => setMenuAnchor(event.currentTarget)}
              >
                <EllipsisVertical size={19} aria-hidden="true" />
              </button>
            )}
          </div>
        </header>
      )}
      {menuAnchor && shownChat && (
        <ChatMenu
          chat={shownChat}
          projects={projects}
          connection={connection}
          anchor={menuAnchor}
          onFind={() => setFinding(true)}
          onChanged={() => void chat.reload()}
          onGone={onNew}
          onClose={() => setMenuAnchor(null)}
        />
      )}
      <PhoneChatSurface>
        <main
          ref={scroller}
          className={`messages-container cp-messages${home && empty ? ' is-home' : ''}`}
          onScroll={(event) => {
            const element = event.currentTarget
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          }}
        >
          {chat.loading ? (
            <p className="cp-placeholder">
              <Loader2 size={20} className="icon-spin" aria-hidden="true" />
              Loading…
            </p>
          ) : empty && home ? (
            <div className="cp-home">
              <Robot className="is-small" />
              <h2>What’s next?</h2>
              <div className="cp-suggestions" aria-label="Suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    className="cp-suggestion"
                    onClick={() =>
                      suggestion.kind === 'open'
                        ? onOpenChat(suggestion.chat)
                        : setPrefill({ text: suggestion.prompt, nonce: Date.now() })
                    }
                  >
                    <span>{suggestion.label}</span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : empty ? (
            <p className="cp-placeholder">No messages yet.</p>
          ) : (
            <Transcript
              messages={chat.messages}
              runActive={chat.runActive}
              editingMessageId={editing?.messageId ?? null}
              onResolve={chat.resolve}
              onEdit={(message) =>
                setEditing({
                  messageId: message.id,
                  text: message.content,
                  nonce: Date.now(),
                  source:
                    scroller.current?.querySelector<HTMLElement>(
                      `.message[data-message-id="${CSS.escape(message.id)}"] .message-bubble`
                    ) ?? null
                })
              }
              onRetry={(message) => {
                following.current = true
                void chat.retry(message.id)
              }}
            />
          )}
        </main>
      </PhoneChatSurface>
      <footer className="cp-composer-area">
        {chat.error && (
          <p className="cp-inline-error" role="alert">
            {chat.error}
          </p>
        )}
        {home && empty && <StartInBar projects={projects} value={where} onChange={setWhere} />}
        <PhoneComposer
          connection={connection}
          runActive={chat.runActive}
          sending={chat.sending}
          stopping={chat.stopping}
          queue={chat.queue}
          models={chat.models}
          prefill={prefill}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSubmitEdit={async (text) => {
            const target = editing
            if (!target) return false
            following.current = true
            const sent = await chat.retry(target.messageId, text)
            if (sent) setEditing(null)
            return sent
          }}
          onSend={(message) => {
            following.current = true
            return chat.send(
              home && where.projectId
                ? { ...message, projectId: where.projectId, workIn: where.workIn }
                : message
            )
          }}
          onStop={() => void chat.stop()}
          onUpdateQueue={(queued) => void chat.updateQueue(queued)}
          onSteerQueued={(id) => void chat.steerQueued(id)}
        />
      </footer>
    </div>
  )
}
