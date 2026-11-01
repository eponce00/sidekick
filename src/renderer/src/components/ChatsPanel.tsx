import { useEffect, useState } from 'react'
import { GitBranch, Workflow } from 'lucide-react'
import {
  SESSION_LIMITS,
  sessionIsActive,
  type SessionFamilyMember,
  type SessionMessage,
  type SessionStatus
} from '../../../shared/sessions'
import { worktreeBranchLabel, type ManagedWorktreeSummary } from '../../../shared/worktrees'
import { useManagedWorktrees } from '../hooks/useManagedWorktrees'
import {
  familyProjectTag,
  memberName,
  memberState,
  type SessionFamilyView
} from '../hooks/useSessionFamily'
import { sessionStateLabel, workerWorkplace } from '../utils/sessionLabels'
import { SessionStateDot } from './SessionChip'
import './ChatFamily.css'

interface ChatsPanelProps {
  conversationId: string
  view: Pick<SessionFamilyView, 'family' | 'role' | 'self' | 'messages' | 'statuses'>
  worktrees: ManagedWorktreeSummary[]
  onOpenChat: (conversationId: string) => void
  /** Opens a chat with its message box ready, for writing to it. */
  onMessageChat: (conversationId: string) => void
  onStop: (conversationId: string) => void | Promise<void>
  onDetach: (conversationId: string) => void | Promise<void>
}

function worktreeOf(
  conversationId: string,
  worktrees: ManagedWorktreeSummary[]
): ManagedWorktreeSummary | null {
  return (
    worktrees.find((worktree) =>
      worktree.owners.some((owner) => owner.kind === 'chat' && owner.id === conversationId)
    ) ?? null
  )
}

function BranchLine({
  worktree
}: {
  worktree: ManagedWorktreeSummary | null
}): React.JSX.Element | null {
  if (!worktree) return null
  const status = worktree.status
  const ahead = status?.ahead ?? 0
  const changed = status?.changedFiles ?? 0
  return (
    <div className="chats-panel-branch">
      <GitBranch size={12} aria-hidden="true" />
      <span className="chats-panel-branch-name">{worktreeBranchLabel(worktree)}</span>
      {ahead > 0 && (
        <span>
          +{ahead} {ahead === 1 ? 'commit' : 'commits'}
        </span>
      )}
      {status && (
        <span className="family-row-muted">
          {changed > 0 ? `${changed} ${changed === 1 ? 'file' : 'files'} changed` : 'clean'}
        </span>
      )}
    </div>
  )
}

function WorkerCard({
  worker,
  status,
  state,
  worktree,
  manager,
  onOpenChat,
  onMessageChat,
  onStop
}: {
  worker: SessionFamilyMember
  status: SessionStatus | undefined
  state: SessionFamilyMember['state']
  worktree: ManagedWorktreeSummary | null
  manager: SessionFamilyMember
} & Pick<ChatsPanelProps, 'onOpenChat' | 'onMessageChat' | 'onStop'>): React.JSX.Element {
  const name = memberName(worker)
  return (
    <li className={`chats-panel-card is-${state}`}>
      <div className="chats-panel-card-top">
        <SessionStateDot state={state} />
        <strong className="chats-panel-name">{name}</strong>
        {familyProjectTag(worker, manager) && (
          <span className="session-chip-project">{familyProjectTag(worker, manager)}</span>
        )}
        <span className={`chats-panel-state session-chip-state-${state}`} title={status?.reason}>
          {sessionStateLabel(state)}
        </span>
      </div>
      <div className="chats-panel-title">{worker.title}</div>
      {status?.reason && state !== 'working' && (
        <div className="chats-panel-reason">{status.reason}</div>
      )}
      <BranchLine worktree={worktree} />
      <div className="chats-panel-actions" role="group" aria-label={`Actions for ${name}`}>
        <button type="button" onClick={() => onOpenChat(worker.conversationId)}>
          Open
        </button>
        <button type="button" onClick={() => onMessageChat(worker.conversationId)}>
          Message
        </button>
        {sessionIsActive(state) && (
          <button
            type="button"
            className="chats-panel-stop"
            onClick={() => void onStop(worker.conversationId)}
          >
            Stop
          </button>
        )}
      </div>
    </li>
  )
}

function briefOf(conversationId: string, messages: SessionMessage[]): SessionMessage | undefined {
  return messages.find(
    (message) => message.intent === 'brief' && message.toConversationId === conversationId
  )
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Focuses the visible chat's message box once the chat has opened. */
function focusVisibleComposer(attempt = 0): void {
  const field = [...document.querySelectorAll<HTMLTextAreaElement>('.chat-panel textarea')].find(
    (candidate) => candidate.offsetParent !== null
  )
  if (field) field.focus()
  else if (attempt < 10) window.setTimeout(() => focusVisibleComposer(attempt + 1), 50)
}

/**
 * The Chats tab: the panel with the worktrees it labels branches from, loaded only while the tab
 * is open because listing them runs Git in each one.
 */
export function ChatsTab({
  conversationId,
  view,
  onOpenChat
}: {
  conversationId: string
  view: SessionFamilyView
  onOpenChat: (conversationId: string) => void
}): React.JSX.Element {
  const { worktrees, refreshWorktrees } = useManagedWorktrees()
  const familyKey = view.family
    ? [view.family.manager, ...view.family.workers]
        .map((member) => `${member.conversationId}:${memberState(member, view.statuses)}`)
        .join('|')
    : ''
  // A worker that finishes has usually committed; its branch line should say so.
  useEffect(() => {
    if (familyKey) void refreshWorktrees()
  }, [familyKey, refreshWorktrees])
  return (
    <ChatsPanel
      conversationId={conversationId}
      view={view}
      worktrees={worktrees}
      onOpenChat={onOpenChat}
      onMessageChat={(id) => {
        onOpenChat(id)
        window.setTimeout(() => focusVisibleComposer(), 0)
      }}
      onStop={async (id) => {
        await window.api.sessions.stop(id)
      }}
      onDetach={async (id) => {
        await window.api.sessions.detach(id)
        await view.reload()
      }}
    />
  )
}

/**
 * The inspector's view of a chat's family. A manager sees every chat it started, with state,
 * branch and actions; a worker sees its family to jump between and the facts about itself.
 */
export function ChatsPanel({
  conversationId,
  view,
  worktrees,
  onOpenChat,
  onMessageChat,
  onStop,
  onDetach
}: ChatsPanelProps): React.JSX.Element {
  const [confirmDetach, setConfirmDetach] = useState(false)
  const { family, role, self, statuses, messages } = view
  if (!family || !role || !self) {
    return (
      <div className="chats-panel chats-panel-empty">
        This chat has not started other chats, and no chat started it.
      </div>
    )
  }

  if (role === 'manager') {
    const workers = family.workers
    return (
      <div className="chats-panel">
        <h3 className="chats-panel-heading">
          Started by this chat <span>{workers.length}</span>
        </h3>
        <ul className="chats-panel-list">
          {workers.map((worker) => (
            <WorkerCard
              key={worker.conversationId}
              worker={worker}
              status={statuses.get(worker.conversationId)}
              state={memberState(worker, statuses)}
              worktree={worktreeOf(worker.conversationId, worktrees)}
              manager={family.manager}
              onOpenChat={onOpenChat}
              onMessageChat={onMessageChat}
              onStop={onStop}
            />
          ))}
        </ul>
        <div className="chats-panel-usage">
          <span>Live chats</span>
          <span>
            {workers.length} of {SESSION_LIMITS.liveWorkersPerFamily}
          </span>
          <span className="chats-panel-meter" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(100, (workers.length / SESSION_LIMITS.liveWorkersPerFamily) * 100)}%`
              }}
            />
          </span>
        </div>
      </div>
    )
  }

  const worktree = worktreeOf(conversationId, worktrees)
  const brief = briefOf(conversationId, messages)
  const state = memberState(self, statuses)
  const workplace = workerWorkplace(self, worktree)
  return (
    <div className="chats-panel">
      <h3 className="chats-panel-heading">Family</h3>
      <ul className="chats-panel-tree">
        <li>
          <button type="button" onClick={() => onOpenChat(family.manager.conversationId)}>
            <Workflow size={13} aria-hidden="true" />
            <span>{family.manager.title}</span>
          </button>
          <ul>
            {family.workers.map((worker) => {
              const current = worker.conversationId === conversationId
              return (
                <li key={worker.conversationId}>
                  <button
                    type="button"
                    className={current ? 'is-current' : ''}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => onOpenChat(worker.conversationId)}
                  >
                    <SessionStateDot state={memberState(worker, statuses)} />
                    <span>{memberName(worker)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </li>
      </ul>
      <h3 className="chats-panel-heading">This chat</h3>
      <dl className="chats-panel-facts">
        <dt>Started by</dt>
        <dd>
          {family.manager.title}
          {brief && `, ${formatTime(brief.createdAt)}`}
        </dd>
        <dt>State</dt>
        <dd>
          {sessionStateLabel(state)}
          {statuses.get(conversationId)?.reason && ` · ${statuses.get(conversationId)?.reason}`}
        </dd>
        {workplace && (
          <>
            <dt>Works in</dt>
            <dd>
              {worktree
                ? `New worktree${worktree.baseRef ? ` from ${worktree.baseRef}` : ''}`
                : workplace}
            </dd>
          </>
        )}
        {worktree && (
          <>
            <dt>Branch</dt>
            <dd>
              <BranchLine worktree={worktree} />
            </dd>
          </>
        )}
        <dt>Reports</dt>
        <dd>
          {self.reportToConversationId ? 'When idle, to the manager' : 'Not reported anywhere'}
        </dd>
      </dl>
      {self.reportToConversationId && (
        <div className="chats-panel-detach">
          {confirmDetach ? (
            <>
              <p>
                This chat will stop reporting to {family.manager.title} and leave its family. Its
                history and worktree stay.
              </p>
              <div className="chats-panel-detach-actions">
                <button
                  type="button"
                  className="settings-secondary-action is-small"
                  onClick={() => setConfirmDetach(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="settings-danger-action is-small"
                  onClick={() => {
                    setConfirmDetach(false)
                    void onDetach(conversationId)
                  }}
                >
                  Detach
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="settings-secondary-action is-small"
              onClick={() => setConfirmDetach(true)}
            >
              Detach from manager
            </button>
          )}
        </div>
      )}
    </div>
  )
}
