import { useState } from 'react'
import './ScheduledRunGroupRow.css'
import { CalendarClock, ChevronDown, ChevronRight } from 'lucide-react'
import type { Conversation } from '../types/app.types'
import type { ScheduledRunGroup } from '../utils/scheduledRunGroups'
import { scheduledRunLabel } from '../utils/scheduledRunGroups'
import {
  CONVERSATION_RUN_STATUS_LABELS,
  conversationRunStatus,
  type ConversationRunStatus
} from '../utils/conversationAttention'

interface ScheduledRunGroupRowProps {
  group: ScheduledRunGroup
  currentConversationId: string | null
  nested?: boolean
  waiting: ReadonlySet<string>
  busy: ReadonlySet<string>
  unread: ReadonlySet<string>
  renderConversation: (conversation: Conversation, title: string) => React.JSX.Element
}

const STATUS_RANK: Record<ConversationRunStatus, number> = { waiting: 3, working: 2, unread: 1 }

/** One sidebar row for a schedule's chats, "name · N runs", that opens to its "Run N" rows. */
export default function ScheduledRunGroupRow({
  group,
  currentConversationId,
  nested,
  waiting,
  busy,
  unread,
  renderConversation
}: ScheduledRunGroupRowProps): React.JSX.Element {
  const containsActive = group.conversations.some(({ id }) => id === currentConversationId)
  // Open while it holds the shown chat, unless the user chose otherwise.
  const [choice, setChoice] = useState<boolean | null>(null)
  const expanded = choice ?? containsActive
  const status = group.conversations.reduce<ConversationRunStatus | null>((strongest, item) => {
    const next = conversationRunStatus(item.id, { waiting, busy, unread })
    return next && (!strongest || STATUS_RANK[next] > STATUS_RANK[strongest]) ? next : strongest
  }, null)
  const count = group.conversations.length
  return (
    <div className="scheduled-run-group">
      <button
        type="button"
        className={`conversation-item scheduled-run-group-row ${nested ? 'nested' : ''} ${
          containsActive && !expanded ? 'contains-active' : ''
        }`}
        onClick={() => setChoice(!expanded)}
        aria-expanded={expanded}
        title={`${group.label}: ${count} scheduled ${count === 1 ? 'run' : 'runs'}`}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <CalendarClock size={14} className="scheduled-run-group-icon" />
        <span className="conversation-title">{group.label}</span>
        {status && (
          <span
            className={`conversation-run-indicator ${status}`}
            title={CONVERSATION_RUN_STATUS_LABELS[status]}
            aria-label={CONVERSATION_RUN_STATUS_LABELS[status]}
          />
        )}
        <span className="scheduled-run-group-count">
          {count} {count === 1 ? 'run' : 'runs'}
        </span>
      </button>
      {expanded && (
        <div className="scheduled-run-group-runs">
          {group.conversations.map((conversation) =>
            renderConversation(conversation, scheduledRunLabel(conversation))
          )}
        </div>
      )}
    </div>
  )
}
