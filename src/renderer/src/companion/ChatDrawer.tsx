import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  Search,
  Smartphone,
  SquarePen,
  Unlink,
  X
} from 'lucide-react'
import type { CompanionChat, CompanionProject } from '../../../shared/companion'
import { SIDEBAR_DOT_LABELS } from '../utils/sessionFamilies'
import { groupChats, searchChats } from './chatGroups'
import { chatDot } from './chatState'
import { useSwipeToClose } from './gestures'
import { useBackLayer } from './navigation'
import { Robot } from './Robot'
import { Sheet, SheetAction } from './Sheet'

/**
 * The chats, in a drawer that slides over the open chat from the left as the ChatGPT and Claude
 * apps keep theirs: search, a new chat, then the desktop sidebar's projects and chats with its
 * marks, and the connection to the computer at the foot.
 */
export function ChatDrawer({
  open,
  chats,
  projects,
  error,
  currentId,
  collapsed,
  onToggle,
  host,
  online,
  deviceName,
  onOpen,
  onNew,
  onNewInProject,
  onClose,
  onForget
}: {
  open: boolean
  chats: CompanionChat[] | null
  projects: readonly CompanionProject[]
  error: string
  /** The chat on screen, marked as the desktop marks the selected row. */
  currentId: string | null
  /** The sections and projects folded away. */
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  /** Where the computer answers. */
  host: string
  online: boolean | null
  deviceName: string
  onOpen: (chat: CompanionChat) => void
  onNew: () => void
  onNewInProject: (project: CompanionProject) => void
  onClose: () => void
  onForget: () => void
}) {
  const [query, setQuery] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  useBackLayer(open, onClose)
  useSwipeToClose(panel, 'left', onClose, open)
  const searching = query.trim() !== ''
  const results = useMemo(
    () => (chats && searching ? searchChats(chats, query) : []),
    [chats, query, searching]
  )
  const groups = useMemo(() => groupChats(chats ?? [], projects), [chats, projects])

  const row = (chat: CompanionChat, options: { nested?: boolean; project?: boolean } = {}) => {
    const dot = chatDot(chat)
    const active = chat.id === currentId
    return (
      <li key={chat.id}>
        <button
          type="button"
          className={`cp-row${options.nested ? ' is-nested' : ''}${active ? ' is-active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => onOpen(chat)}
        >
          <span className="cp-row-text">
            <span className="cp-row-title">
              {chat.inWorktree && (
                <GitBranch
                  size={14}
                  className="cp-row-worktree"
                  role="img"
                  aria-label="In its own worktree"
                />
              )}
              {chat.title || 'Untitled chat'}
            </span>
            {options.project && chat.projectName && (
              <span className="cp-row-meta">{chat.projectName}</span>
            )}
          </span>
          {dot && (
            <span
              className={`conversation-run-indicator ${dot}`}
              role="img"
              aria-label={SIDEBAR_DOT_LABELS[dot]}
            />
          )}
        </button>
      </li>
    )
  }

  const section = (key: string, label: string, children: ReactNode) => {
    const folded = collapsed.has(key)
    return (
      <section className="cp-section" aria-label={label}>
        <button
          type="button"
          className="cp-section-label"
          aria-expanded={!folded}
          onClick={() => onToggle(key)}
        >
          <ChevronDown
            size={14}
            className={`sidebar-section-chevron ${folded ? 'is-collapsed' : ''}`}
            aria-hidden="true"
          />
          {label}
        </button>
        {!folded && children}
      </section>
    )
  }

  let body: ReactNode
  if (chats === null) {
    body = !error && (
      <p className="cp-placeholder">
        <Loader2 size={18} className="icon-spin" aria-hidden="true" />
        Loading chats…
      </p>
    )
  } else if (chats.length === 0 && projects.length === 0) {
    body = (
      <div className="cp-empty">
        <Robot className="is-small" />
        <p>No chats yet</p>
      </div>
    )
  } else if (searching) {
    body = (
      <section className="cp-section" aria-label="Search results">
        <div className="cp-section-label is-static">Search results</div>
        {results.length ? (
          <ul className="cp-rows">{results.map((chat) => row(chat, { project: true }))}</ul>
        ) : (
          <p className="cp-placeholder is-compact">No matching chats</p>
        )}
      </section>
    )
  } else {
    body = (
      <>
        {groups.projects.length > 0 &&
          section(
            'section:projects',
            'Projects',
            groups.projects.map((group) => {
              const key = `project:${group.project?.id ?? group.name}`
              const folded = collapsed.has(key)
              const FolderIcon = folded ? Folder : FolderOpen
              const holdsCurrent = group.chats.some((chat) => chat.id === currentId)
              const project = group.project
              return (
                <div className="cp-project" key={key}>
                  <div className={`cp-project-head${holdsCurrent ? ' contains-active' : ''}`}>
                    <button
                      type="button"
                      className="cp-project-row"
                      aria-expanded={!folded}
                      onClick={() => onToggle(key)}
                    >
                      <ChevronDown
                        size={16}
                        className={`cp-project-chevron sidebar-section-chevron ${folded ? 'is-collapsed' : ''}`}
                        aria-hidden="true"
                      />
                      <FolderIcon size={18} className="cp-project-icon" aria-hidden="true" />
                      <span className="cp-project-name">{group.name}</span>
                    </button>
                    {project && (
                      <button
                        type="button"
                        className="cp-project-new"
                        aria-label={`New chat in ${project.name}`}
                        onClick={() => onNewInProject(project)}
                      >
                        <Plus size={20} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {!folded &&
                    (group.chats.length ? (
                      <ul className="cp-rows">
                        {group.chats.map((chat) => row(chat, { nested: true }))}
                      </ul>
                    ) : (
                      <p className="cp-project-empty">No chats yet</p>
                    ))}
                </div>
              )
            })
          )}
        {groups.chats.length > 0 &&
          section(
            'section:chats',
            'Chats',
            <ul className="cp-rows">{groups.chats.map((chat) => row(chat))}</ul>
          )}
      </>
    )
  }

  return (
    <div className={`cp-drawer-root${open ? ' is-open' : ''}`} inert={!open}>
      <div className="cp-drawer-scrim" aria-hidden="true" onClick={onClose} />
      <nav ref={panel} className="cp-drawer" aria-label="Chats">
        <div className="cp-drawer-top">
          <label className="sidebar-search field-shell cp-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchInput}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              enterKeyHint="search"
            />
            {query && (
              <button
                type="button"
                className="cp-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('')
                  searchInput.current?.focus()
                }}
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
        <div className="cp-scroll cp-list">
          <button type="button" className="cp-row cp-new-row" onClick={onNew}>
            <SquarePen size={18} className="cp-new-row-icon" aria-hidden="true" />
            <span className="cp-row-title">New chat</span>
          </button>
          {error && (
            <p className="cp-inline-error" role="alert">
              {error}
            </p>
          )}
          {body}
        </div>
        <button
          type="button"
          className="cp-drawer-connection"
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <span className={`cp-status-dot${online ? ' is-online' : ''}`} aria-hidden="true" />
          <span className="cp-drawer-connection-text">
            {online ? 'Connected to' : online === null ? 'Connecting to' : 'Reconnecting to'} {host}
          </span>
        </button>
      </nav>
      {moreOpen && (
        <Sheet label="This phone" onClose={() => setMoreOpen(false)}>
          <div className="cp-sheet-info" role="status">
            <span className="cp-sheet-info-icon" aria-hidden="true">
              <span className={`cp-status-dot${online ? ' is-online' : ''}`} />
            </span>
            <span className="cp-sheet-info-text">
              {online ? 'Connected to' : online === null ? 'Connecting to' : 'Reconnecting to'}{' '}
              {host}
            </span>
          </div>
          <div className="cp-sheet-info">
            <span className="cp-sheet-info-icon" aria-hidden="true">
              <Smartphone size={18} />
            </span>
            <span className="cp-sheet-info-text">
              This phone: <span className="cp-sheet-info-value">{deviceName}</span>
            </span>
          </div>
          <SheetAction
            icon={<Unlink size={18} />}
            label="Forget this phone"
            tone="danger"
            onClick={() => {
              setMoreOpen(false)
              onForget()
            }}
          />
        </Sheet>
      )}
    </div>
  )
}
