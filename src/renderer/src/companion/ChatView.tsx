import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronLeft, Loader2, Square } from 'lucide-react'
import type { CompanionConnection } from './chatState'
import { Transcript } from './Transcript'
import { useCompanionChat, type Subscribe } from './useCompanionChat'

const COMPOSER_MAX_HEIGHT = 160

function Composer({
  runActive,
  sending,
  stopping,
  onSend,
  onStop
}: {
  runActive: boolean
  sending: boolean
  stopping: boolean
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
    // A scroll bar only once the field stops growing.
    element.style.overflowY = element.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [text])
  const trimmed = text.trim()
  const submit = async (): Promise<void> => {
    if (!trimmed || sending) return
    setText('')
    // A failed send gives the text back so nothing typed is lost.
    if (!(await onSend(trimmed))) setText((current) => current || trimmed)
  }
  return (
    <form
      className="cp-composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <textarea
        ref={field}
        value={text}
        rows={1}
        placeholder={runActive ? 'Add to what SideKick is doing' : 'Message SideKick'}
        aria-label="Message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter makes a new line on a phone keyboard; a hardware keyboard sends with Ctrl+Enter.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      {runActive && (
        <button
          type="button"
          className="cp-icon-button is-stop"
          aria-label="Stop"
          title="Stop"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? (
            <Loader2 size={18} className="icon-spin" aria-hidden="true" />
          ) : (
            <Square size={16} fill="currentColor" aria-hidden="true" />
          )}
        </button>
      )}
      <button
        type="submit"
        className="cp-icon-button is-send"
        aria-label="Send"
        title="Send"
        disabled={!trimmed || sending}
      >
        {sending ? (
          <Loader2 size={18} className="icon-spin" aria-hidden="true" />
        ) : (
          <ArrowUp size={20} strokeWidth={2.4} aria-hidden="true" />
        )}
      </button>
    </form>
  )
}

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
  }, [chat.messages, chat.liveSegments, chat.unconfirmed, chat.error])

  const title = chat.chat?.title || fallbackTitle || 'New chat'
  const empty =
    !chat.loading && !chat.messages.length && !chat.liveSegments.length && !chat.unconfirmed.length
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
      <main
        ref={scroller}
        className="cp-scroll"
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
            liveSegments={chat.liveSegments}
            runActive={chat.runActive}
            phase={chat.phase}
            unconfirmed={chat.unconfirmed}
            answered={chat.answered}
            onResolve={(id, response, cancelled) => void chat.resolve(id, response, cancelled)}
          />
        )}
      </main>
      <footer className="cp-composer-area">
        {chat.error && (
          <p className="cp-inline-error" role="alert">
            {chat.error}
          </p>
        )}
        <Composer
          runActive={chat.runActive}
          sending={chat.sending}
          stopping={chat.stopping}
          onSend={(text) => {
            following.current = true
            return chat.send(text)
          }}
          onStop={() => void chat.stop()}
        />
      </footer>
    </div>
  )
}
