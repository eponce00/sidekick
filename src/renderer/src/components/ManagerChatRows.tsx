import { useId, useState } from 'react'
import { ChevronRight, Inbox, Workflow } from 'lucide-react'
import {
  sessionIsActive,
  type SessionFamilyMember,
  type SessionMessage,
  type SessionState,
  type SessionStatus
} from '../../../shared/sessions'
import { familyProjectTag, memberName, memberState } from '../hooks/useSessionFamily'
import { sessionStateLabel } from '../utils/sessionLabels'
import { SessionChip, SessionStateDot } from './SessionChip'
import { StopGlyph } from './StopGlyph'
import './ChatFamily.css'

interface FamilyContext {
  /** Family members by chat id. */
  members: Map<string, SessionFamilyMember>
  statuses: Map<string, SessionStatus>
  /** The family's manager, so a worker in another project carries that project's tag. */
  manager: SessionFamilyMember | null
  onOpenChat: (conversationId: string) => void
}

function workplace(members: SessionFamilyMember[]): string {
  const places = new Set(members.map((member) => member.workIn))
  if (places.size !== 1) return ''
  const [place] = places
  if (place === 'worktree') return members.length > 1 ? 'each in its own worktree' : 'in a worktree'
  if (place === 'folder') return "in this chat's folder"
  if (place === 'read-only') return 'read-only'
  return ''
}

/** "Started N chats": one chip per worker, each carrying its live state. */
export function StartedChatsRow({
  briefs,
  members,
  statuses,
  manager,
  onOpenChat
}: FamilyContext & { briefs: SessionMessage[] }): React.JSX.Element | null {
  const started = briefs
    .map((brief) => members.get(brief.toConversationId))
    .filter((member): member is SessionFamilyMember => Boolean(member))
  if (!started.length) return null
  const where = workplace(started)
  return (
    <section className="family-started" aria-label={`Started ${started.length} chats`}>
      <div className="family-row-heading">
        <Workflow size={14} aria-hidden="true" />
        <span>
          Started {started.length} {started.length === 1 ? 'chat' : 'chats'}
          {where && <span className="family-row-muted"> · {where}</span>}
        </span>
      </div>
      <div className="family-chips">
        {started.map((member) => (
          <SessionChip
            key={member.conversationId}
            name={memberName(member)}
            state={memberState(member, statuses)}
            projectTag={familyProjectTag(member, manager)}
            onOpen={() => onOpenChat(member.conversationId)}
          />
        ))}
      </div>
    </section>
  )
}

const INTENT_LABELS: Record<SessionMessage['intent'], string> = {
  brief: 'brief',
  request: 'request',
  response: 'reply',
  update: 'update',
  report: 'report',
  status: 'status'
}

function firstLine(body: string): string {
  return (
    body
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  )
}

/**
 * Reports and requests that reached the manager fold into one quiet row, the way an answered
 * question does. Expanded, each line says who sent it, where they stand, and how to get there.
 */
export function ReceivedMessagesRow({
  messages,
  members,
  statuses,
  onOpenChat
}: FamilyContext & { messages: SessionMessage[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const senders = [
    ...new Set(messages.map((message) => message.fromConversationId).filter(Boolean))
  ] as string[]
  const initials = senders.slice(0, 3).map((id) => {
    const member = members.get(id)
    return { id, letter: (member ? memberName(member) : '?').charAt(0).toUpperCase() }
  })
  const count = `Received ${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`
  return (
    <section className={`family-received${expanded ? ' is-expanded' : ''}`} aria-label={count}>
      <button
        type="button"
        className="family-received-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        {/* The icon takes a work step's 16px column, so the label starts where a step's does. */}
        <span className="family-received-icon" aria-hidden="true">
          <Inbox size={14} />
        </span>
        <span>{count}</span>
        <span className="family-initials" aria-hidden="true">
          {initials.map(({ id, letter }) => (
            <span key={id}>{letter}</span>
          ))}
        </span>
        <ChevronRight
          size={12}
          className={`family-chevron${expanded ? ' is-expanded' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ul className="family-received-list" id={listId}>
          {messages.map((message) => {
            const sender = message.fromConversationId
              ? members.get(message.fromConversationId)
              : undefined
            const state: SessionState = sender ? memberState(sender, statuses) : 'idle'
            const waiting = state === 'waiting'
            return (
              <li key={message.id}>
                <SessionStateDot state={state} />
                <div className="family-received-copy">
                  <strong>{sender ? memberName(sender) : 'SideKick'}</strong>{' '}
                  {sender && (
                    <span className={`family-received-state is-${state}`}>
                      {sessionStateLabel(state)}.
                    </span>
                  )}{' '}
                  <span className="family-received-body">{firstLine(message.body)}</span>
                  <span className="family-row-muted"> · {INTENT_LABELS[message.intent]}</span>
                </div>
                {sender && (
                  <button
                    type="button"
                    className="family-link"
                    onClick={() => onOpenChat(sender.conversationId)}
                  >
                    {waiting ? 'Go to approval' : 'Open'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const STRIP_ORDER: SessionState[] = ['working', 'queued', 'waiting', 'failed', 'done', 'stopped']
const STRIP_LABELS: Partial<Record<SessionState, string>> = {
  working: 'working',
  queued: 'queued',
  waiting: 'need you',
  failed: 'failed',
  done: 'done',
  stopped: 'stopped'
}

/**
 * Above the composer of a manager: how its chats stand, and one way to stop them all. Stopping
 * every worker at once is easy to regret, so it asks once more in place.
 */
export function FamilyStrip({
  workers,
  statuses,
  onStopAll
}: {
  workers: SessionFamilyMember[]
  statuses: Map<string, SessionStatus>
  onStopAll: (conversationIds: string[]) => void | Promise<void>
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)
  if (!workers.length) return null
  const states = workers.map((worker) => ({ worker, state: memberState(worker, statuses) }))
  const active = states.filter(({ state }) => sessionIsActive(state))
  const counts = STRIP_ORDER.map((state) => ({
    state,
    count: states.filter((entry) => entry.state === state).length
  })).filter(({ count }) => count > 0)
  return (
    <div className="family-strip" role="status" aria-label="Chats started here">
      <span className="family-strip-counts">
        {counts.map(({ state, count }) => (
          <span key={state} className="family-strip-count">
            <SessionStateDot state={state} />
            {count} {state === 'waiting' && count === 1 ? 'needs you' : STRIP_LABELS[state]}
          </span>
        ))}
        {!counts.length && <span className="family-row-muted">All chats idle</span>}
      </span>
      {active.length > 0 &&
        (confirming ? (
          <span className="family-strip-confirm">
            <span>
              Stop {active.length} {active.length === 1 ? 'chat' : 'chats'}?
            </span>
            <button
              type="button"
              className="settings-ghost-action is-small family-strip-stop"
              onClick={() => {
                setConfirming(false)
                void onStopAll(active.map(({ worker }) => worker.conversationId))
              }}
            >
              Stop
            </button>
            <button
              type="button"
              className="settings-ghost-action is-small"
              onClick={() => setConfirming(false)}
            >
              Keep running
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="settings-ghost-action is-small family-strip-stop"
            onClick={() => setConfirming(true)}
          >
            <StopGlyph /> Stop all
          </button>
        ))}
    </div>
  )
}
