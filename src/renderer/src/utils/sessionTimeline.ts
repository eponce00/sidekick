import type { SessionMessage } from '../../../shared/sessions'

/**
 * What a chat's family adds to its transcript. A manager sees the chats it started and the
 * messages it received; a worker sees its brief and the messages sent to it.
 */
export type SessionTimelineRow =
  | { kind: 'started'; key: string; at: number; briefs: SessionMessage[] }
  | { kind: 'received'; key: string; at: number; messages: SessionMessage[] }
  | { kind: 'brief'; key: string; at: number; message: SessionMessage }
  | { kind: 'message'; key: string; at: number; message: SessionMessage }

/**
 * A worker's brief is also its first user message, with the same id. These are the ids to leave
 * out of the transcript, so the brief shows once, as the brief from its manager.
 */
export function workerBriefIds(
  conversationId: string,
  role: 'manager' | 'worker' | null,
  messages: readonly SessionMessage[]
): Set<string> {
  if (role !== 'worker') return new Set()
  return new Set(
    messages
      .filter(
        (message) => message.intent === 'brief' && message.toConversationId === conversationId
      )
      .map((message) => message.id)
  )
}

/**
 * Places family rows between a chat's own messages by time. The result maps a gap to its rows:
 * gap 0 comes before the first message and gap n after the n-th. Rows of one kind that land in
 * the same gap merge, so five briefs sent together read as one "Started 5 chats".
 */
export function sessionTimeline(
  conversationId: string,
  role: 'manager' | 'worker' | null,
  messages: readonly SessionMessage[],
  messageTimes: readonly number[]
): Map<number, SessionTimelineRow[]> {
  const gaps = new Map<number, SessionTimelineRow[]>()
  if (!role) return gaps
  const gapOf = (at: number): number => {
    let gap = 0
    while (gap < messageTimes.length && messageTimes[gap] <= at) gap += 1
    return gap
  }
  const ordered = [...messages].sort((left, right) => left.createdAt - right.createdAt)
  for (const message of ordered) {
    const incoming = message.toConversationId === conversationId
    let row: SessionTimelineRow | null = null
    if (role === 'manager') {
      if (!incoming && message.intent === 'brief')
        row = { kind: 'started', key: message.id, at: message.createdAt, briefs: [message] }
      else if (incoming)
        row = { kind: 'received', key: message.id, at: message.createdAt, messages: [message] }
    } else if (incoming) {
      row =
        message.intent === 'brief'
          ? { kind: 'brief', key: message.id, at: message.createdAt, message }
          : { kind: 'message', key: message.id, at: message.createdAt, message }
    }
    if (!row) continue
    const gap = gapOf(row.at)
    const rows = gaps.get(gap) ?? []
    const last = rows.at(-1)
    if (last?.kind === 'started' && row.kind === 'started') last.briefs.push(...row.briefs)
    else if (last?.kind === 'received' && row.kind === 'received')
      last.messages.push(...row.messages)
    else rows.push(row)
    gaps.set(gap, rows)
  }
  return gaps
}
