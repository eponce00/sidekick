import { Loader2, Pin, Plus } from 'lucide-react'
import type { CompanionChat } from '../../../shared/companion'
import { chatBadge, relativeTime } from './chatState'

export function ChatList({
  chats,
  now,
  error,
  deviceName,
  onOpen,
  onNew,
  onForget
}: {
  chats: CompanionChat[] | null
  /** When the list's ages are counted from. */
  now: number
  error: string
  deviceName: string
  onOpen: (chat: CompanionChat) => void
  onNew: () => void
  onForget: () => void
}) {
  return (
    <div className="cp-screen">
      <header className="cp-header is-list">
        <div className="cp-header-text">
          <h1>SideKick</h1>
        </div>
        <button type="button" className="cp-button is-primary is-compact" onClick={onNew}>
          <Plus size={18} aria-hidden="true" />
          New chat
        </button>
      </header>
      <main className="cp-scroll">
        {error && (
          <p className="cp-inline-error" role="alert">
            {error}
          </p>
        )}
        {chats === null ? (
          !error && (
            <p className="cp-placeholder">
              <Loader2 size={20} className="icon-spin" aria-hidden="true" />
              Loading chats…
            </p>
          )
        ) : chats.length === 0 ? (
          <p className="cp-placeholder">No chats yet. Start one with New chat.</p>
        ) : (
          <ul className="cp-chat-list">
            {chats.map((chat) => {
              const badge = chatBadge(chat)
              return (
                <li key={chat.id}>
                  <button type="button" className="cp-chat" onClick={() => onOpen(chat)}>
                    <span className="cp-chat-top">
                      {chat.pinned && <Pin size={14} className="cp-chat-pin" aria-label="Pinned" />}
                      <span className="cp-chat-title">{chat.title || 'Untitled chat'}</span>
                      <span className="cp-chat-time">{relativeTime(chat.updatedAt, now)}</span>
                    </span>
                    {(chat.projectName || badge) && (
                      <span className="cp-chat-meta">
                        {chat.projectName && (
                          <span className="cp-chat-project">{chat.projectName}</span>
                        )}
                        {badge && (
                          <span className={`cp-badge is-${badge}`}>
                            {badge === 'answer' ? 'Needs your answer' : 'Working…'}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <footer className="cp-list-footer">
          <p>{deviceName}</p>
          <button type="button" className="cp-button is-quiet" onClick={onForget}>
            Forget this phone
          </button>
        </footer>
      </main>
    </div>
  )
}
