import { useId, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  GitBranch,
  MessageSquare,
  Workflow
} from 'lucide-react'
import {
  sessionIsActive,
  type SessionFamilyMember,
  type SessionMessage,
  type SessionState
} from '../../../shared/sessions'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'
import { memberName } from '../hooks/useSessionFamily'
import { sessionStateLabel } from '../utils/sessionLabels'
import { SessionStateDot } from './SessionChip'
import './ChatFamily.css'

/**
 * The top of a worker chat: the way back to its manager, what it is called, how it stands, and
 * where it works.
 */
export function WorkerChatHeader({
  worker,
  manager,
  state,
  reason,
  worktree,
  onOpenChat,
  onStop
}: {
  worker: SessionFamilyMember
  manager: SessionFamilyMember
  state: SessionState
  reason?: string
  worktree?: ManagedWorktreeSummary | null
  onOpenChat: (conversationId: string) => void
  onStop: () => void | Promise<void>
}): React.JSX.Element {
  const branch = worktree?.branch
  return (
    <header className="worker-header">
      <div className="worker-header-main">
        <nav aria-label="Chat family" className="worker-breadcrumb">
          <button type="button" onClick={() => onOpenChat(manager.conversationId)}>
            <ArrowLeft size={13} aria-hidden="true" />
            {manager.title}
          </button>
          <span aria-hidden="true">/</span>
        </nav>
        <div className="worker-header-title">
          <h2>{memberName(worker)}</h2>
          <span
            className={`worker-state worker-state-${state}`}
            title={reason}
            aria-label={`State: ${sessionStateLabel(state)}${reason ? `. ${reason}` : ''}`}
          >
            <SessionStateDot state={state} />
            {sessionStateLabel(state)}
          </span>
        </div>
        <div className="worker-header-meta">
          <span className="worker-header-task">{worker.title}</span>
          {branch && (
            <span className="worker-header-branch">
              <GitBranch size={12} aria-hidden="true" />
              {branch}
              {worktree?.sourceProjectName && (
                <span className="family-row-muted">
                  {' '}
                  (worktree of {worktree.sourceProjectName})
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {sessionIsActive(state) && (
        <button type="button" className="worker-header-stop" onClick={() => void onStop()}>
          <CircleStop size={14} aria-hidden="true" /> Stop
        </button>
      )}
    </header>
  )
}

/** Says who started this chat, where its reports go, and that typing here reaches only it. */
export function WorkerBanner({
  manager,
  reportsToManager,
  onOpenChat
}: {
  manager: SessionFamilyMember
  reportsToManager: boolean
  onOpenChat: (conversationId: string) => void
}): React.JSX.Element {
  return (
    <div className="worker-banner" role="note">
      <Workflow size={14} aria-hidden="true" />
      <p>
        Started by{' '}
        <button
          type="button"
          className="family-link"
          onClick={() => onOpenChat(manager.conversationId)}
        >
          {manager.title}
        </button>
        .{' '}
        {reportsToManager
          ? 'When this chat goes idle, its last message is sent there.'
          : 'This chat no longer reports there.'}{' '}
        What you type here goes to this chat only.
      </p>
    </div>
  )
}

/** A worker's first message, written by its manager: a task, not something the user said. */
export function BriefCard({
  brief,
  managerTitle
}: {
  brief: SessionMessage
  managerTitle: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const bodyId = useId()
  return (
    <section className="family-brief" aria-label={`Brief from ${managerTitle}`}>
      <button
        type="button"
        className="family-brief-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        <MessageSquare size={14} aria-hidden="true" />
        <span>
          Brief from <strong>{managerTitle}</strong>
        </span>
        <ChevronRight
          size={14}
          className={`family-chevron${expanded ? ' is-expanded' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="family-brief-body" id={bodyId}>
          {brief.body}
        </div>
      )}
    </section>
  )
}

const INTENT_PREFIX: Partial<Record<SessionMessage['intent'], string>> = {
  request: 'Request from',
  response: 'Reply from',
  update: 'Message from',
  status: 'Note from',
  report: 'Report from'
}

/**
 * One line for each later message from the manager or a sibling, quoted rather than shown as
 * the user's own words. It expands to the full text when it is longer than a line.
 */
export function SessionMessageRow({
  message,
  sender,
  onOpenChat
}: {
  message: SessionMessage
  sender: SessionFamilyMember | undefined
  onOpenChat: (conversationId: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const name = sender ? memberName(sender) : 'SideKick'
  const prefix = INTENT_PREFIX[message.intent] ?? 'Message from'
  return (
    <section
      className={`family-message${expanded ? ' is-expanded' : ''}`}
      aria-label={`${prefix} ${name}`}
    >
      <button
        type="button"
        className="family-message-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="family-initials" aria-hidden="true">
          <span>{name.charAt(0).toUpperCase()}</span>
        </span>
        <span className="family-message-summary">
          {prefix} {name}: <q>{message.body}</q>
        </span>
        <ChevronRight
          size={14}
          className={`family-chevron${expanded ? ' is-expanded' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="family-message-body" id={bodyId}>
          <p>{message.body}</p>
          {sender && (
            <button
              type="button"
              className="family-link"
              onClick={() => onOpenChat(sender.conversationId)}
            >
              Open {name}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
