import { useLayoutEffect, useRef } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import type { CompanionConnection } from './chatState'
import { PhoneChatSurface } from './PhoneChatSurface'
import { PhoneComposer } from './PhoneComposer'
import { Transcript } from './Transcript'
import { useCompanionChat, type Subscribe } from './useCompanionChat'

export function ChatView({
  connection,
  conversationId,
  fallbackTitle,
  subscribe,
  reconnects,
  onBack,
  onCreated,
  onFailure
}: {
  connection: CompanionConnection
  conversationId: string | null
  /** The list's title while the chat loads. */
  fallbackTitle: string
  subscribe: Subscribe
  reconnects: number
  onBack: () => void
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
  const scroller = useRef<HTMLDivElement>(null)
  // Follows new output while the reader is at the bottom, and leaves them alone once they scroll up.
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [chat.messages, chat.error, chat.queue])

  const title = chat.chat?.title || fallbackTitle || 'New chat'
  const empty = !chat.loading && !chat.messages.length
  return (
    <div className="cp-screen">
      <header className="cp-header">
        <button
          type="button"
          className="cp-icon-button"
          aria-label="Back to chats"
          onClick={onBack}
        >
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
        <div className="cp-header-text">
          <h1>{title}</h1>
          {chat.chat?.projectName && <p>{chat.chat.projectName}</p>}
        </div>
      </header>
      <PhoneChatSurface>
        <main
          ref={scroller}
          className="messages-container cp-messages"
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
          ) : empty ? (
            <p className="cp-placeholder">
              {chat.conversationId ? 'No messages yet.' : 'What should SideKick do?'}
            </p>
          ) : (
            <Transcript
              messages={chat.messages}
              runActive={chat.runActive}
              onResolve={chat.resolve}
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
        <PhoneComposer
          connection={connection}
          runActive={chat.runActive}
          sending={chat.sending}
          stopping={chat.stopping}
          queue={chat.queue}
          models={chat.models}
          onSend={(message) => {
            following.current = true
            return chat.send(message)
          }}
          onStop={() => void chat.stop()}
          onUpdateQueue={(queued) => void chat.updateQueue(queued)}
          onSteerQueued={(id) => void chat.steerQueued(id)}
        />
      </footer>
    </div>
  )
}
