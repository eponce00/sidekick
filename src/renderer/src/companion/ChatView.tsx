import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, Loader2, Menu, SquarePen } from 'lucide-react'
import type { CompanionChat } from '../../../shared/companion'
import {
  stopVoiceLoop,
  voiceLoopReplyFinished,
  voiceLoopReplyStarted
} from '../services/voice/voiceLoop'
import { finalAnswerText } from '../utils/segmentGrouping'
import type { CompanionConnection } from './chatState'
import type { HomeSuggestion } from './homeSuggestions'
import { PhoneChatSurface } from './PhoneChatSurface'
import { PhoneComposer } from './PhoneComposer'
import { Robot } from './Robot'
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
  const scroller = useRef<HTMLDivElement>(null)
  // Follows new output while the reader is at the bottom, and leaves them alone once they scroll up.
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [chat.messages, chat.error, chat.queue])

  // Voice conversation, as the desktop's chat drives it: each finished reply's answer is read
  // aloud, then the microphone listens again. Another chat ends it; a new chat getting its ID as
  // the first message is sent is the same chat.
  const messagesRef = useRef(chat.messages)
  useEffect(() => {
    messagesRef.current = chat.messages
  }, [chat.messages])
  const voiceRun = useRef({ conversationId: chat.conversationId, runActive: chat.runActive })
  useEffect(() => {
    const previous = voiceRun.current
    voiceRun.current = { conversationId: chat.conversationId, runActive: chat.runActive }
    if (previous.conversationId && previous.conversationId !== chat.conversationId) {
      stopVoiceLoop()
      return undefined
    }
    if (chat.runActive && !previous.runActive) voiceLoopReplyStarted()
    if (chat.runActive || !previous.runActive) return undefined
    // The saved message replaces the streamed one a moment after the run ends.
    const timer = window.setTimeout(() => {
      const reply = messagesRef.current.findLast((message) => message.role === 'agent')
      voiceLoopReplyFinished(reply ? finalAnswerText(reply) : '')
    }, 200)
    return () => window.clearTimeout(timer)
  }, [chat.conversationId, chat.runActive])

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
          prefill={prefill}
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
