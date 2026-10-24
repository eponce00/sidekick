import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, Loader2, Menu, SquarePen } from 'lucide-react'
import type { CompanionChat, CompanionProject } from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import type { HomeSuggestion } from './homeSuggestions'
import { PhoneChatSurface } from './PhoneChatSurface'
import { PhoneComposer } from './PhoneComposer'
import { Robot } from './Robot'
import { StartInBar, type StartIn } from './StartInBar'
import { Transcript } from './Transcript'
import { useCompanionChat, type Subscribe } from './useCompanionChat'

/**
 * One chat, or with no chat the new-chat home, under a top bar laid out as the ChatGPT and Claude
 * apps have theirs: the drawer's menu on the left, the chat's name in the middle, a new chat on the
 * right.
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
  const [editing, setEditing] = useState<{ messageId: string; text: string; nonce: number } | null>(
    null
  )
  const scroller = useRef<HTMLDivElement>(null)
  // Follows new output while the reader is at the bottom, and leaves them alone once they scroll up.
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [chat.messages, chat.error, chat.queue])

  const home = !chat.conversationId
  const empty = !chat.loading && !chat.messages.length
  const title = home ? 'SideKick' : chat.chat?.title || fallbackTitle || 'New chat'
  const project = home ? null : chat.chat?.projectName
  return (
    <div className="cp-screen">
      <header className="cp-header is-chat">
        <button type="button" className="cp-icon-button" aria-label="Chats" onClick={onMenu}>
          <Menu size={20} aria-hidden="true" />
        </button>
        <div className="cp-header-text">
          <h1>{title}</h1>
          {project && <p>{project}</p>}
        </div>
        <button
          type="button"
          className="cp-icon-button"
          aria-label="New chat"
          disabled={home && empty}
          onClick={onNew}
        >
          <SquarePen size={19} aria-hidden="true" />
        </button>
      </header>
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
                setEditing({ messageId: message.id, text: message.content, nonce: Date.now() })
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
