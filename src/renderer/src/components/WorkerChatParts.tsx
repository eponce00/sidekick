import { useId, useState } from 'react'
import { ArrowLeft, ChevronRight, GitBranch, MessageSquare } from 'lucide-react'
import {
  sessionIsActive,
  type SessionFamilyMember,
  type SessionMessage,
  type SessionState
} from '../../../shared/sessions'
import { worktreeBranchLabel, type ManagedWorktreeSummary } from '../../../shared/worktrees'
import { memberName } from '../hooks/useSessionFamily'
import { sessionStateLabel } from '../utils/sessionLabels'
import { SessionStateDot } from './SessionChip'
import { MessageMarkdown } from './MessageMarkdown'
import { StopGlyph } from './StopGlyph'
import './ChatFamily.css'

/**
 * The top of a worker chat, on one line: the way back to its manager, what it is called, how it
 * stands, and where it works. Where its reports go is in the back button's tooltip.
 */
export function WorkerChatHeader({
  worker,
  manager,
  state,
  reason,
  worktree,
  reportsToManager = true,
  onOpenChat,
  onStop
}: {
  worker: SessionFamilyMember
  manager: SessionFamilyMember
  state: SessionState
  reason?: string
  worktree?: ManagedWorktreeSummary | null
  reportsToManager?: boolean
  onOpenChat: (conversationId: string) => void
  onStop: () => void | Promise<void>
}): React.JSX.Element {
  const branch = worktree ? worktreeBranchLabel(worktree) : undefined
  return (
    <header className="worker-header">
      <nav aria-label="Chat family" className="worker-breadcrumb">
        <button
          type="button"
          onClick={() => onOpenChat(manager.conversationId)}
          title={`Back to ${manager.title}. ${
            reportsToManager
              ? 'This chat sends its last message there when it goes idle; what you type here stays here.'
              : 'This chat no longer reports there.'
          }`}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          <span>{manager.title}</span>
        </button>
        <ChevronRight size={13} aria-hidden="true" className="worker-breadcrumb-separator" />
      </nav>
      <h2 title={worker.title}>{memberName(worker)}</h2>
      <span
        className={`worker-state worker-state-${state}`}
        title={reason}
        aria-label={`State: ${sessionStateLabel(state)}${reason ? `. ${reason}` : ''}`}
      >
        <SessionStateDot state={state} />
        {sessionStateLabel(state)}
      </span>
      {!reportsToManager && <span className="worker-header-detached">Not reporting</span>}
      <span className="worker-header-end">
        {branch && (
          <span
            className="worker-header-branch"
            title={
              worktree?.sourceProjectName ? `Worktree of ${worktree.sourceProjectName}` : undefined
            }
          >
            <GitBranch size={12} aria-hidden="true" />
            {branch}
          </span>
        )}
        {sessionIsActive(state) && (
          <button type="button" className="worker-header-stop" onClick={() => void onStop()}>
            <StopGlyph /> Stop
          </button>
        )}
      </span>
    </header>
  )
}

/** A worker's first message, written by its manager: a task, not something the user said. */
export function BriefCard({
  brief,
  managerTitle,
  workspaceRoot
}: {
  brief: SessionMessage
  managerTitle: string
  workspaceRoot?: string | null
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
        <div className="family-brief-body message-content" id={bodyId}>
          <MessageMarkdown content={brief.body} workspaceRoot={workspaceRoot} />
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
