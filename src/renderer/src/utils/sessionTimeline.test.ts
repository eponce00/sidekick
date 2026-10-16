import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '../../../shared/sessions'
import { sessionTimeline } from './sessionTimeline'

const message = (
  id: string,
  from: string | null,
  to: string,
  intent: SessionMessage['intent'],
  createdAt: number
): SessionMessage => ({
  id,
  fromConversationId: from,
  toConversationId: to,
  intent,
  body: id,
  attachments: [],
  replyToMessageId: null,
  createdAt,
  deliveredRunId: null,
  deliveredAt: null,
  readAt: null
})

describe('sessionTimeline', () => {
  it('merges briefs sent together and reports received together into one row each', () => {
    const rows = sessionTimeline(
      'manager',
      'manager',
      [
        message('report-b', 'b', 'manager', 'report', 250),
        message('brief-a', 'manager', 'a', 'brief', 110),
        message('brief-b', 'manager', 'b', 'brief', 120),
        message('report-a', 'a', 'manager', 'report', 240),
        message('request-a', 'a', 'manager', 'request', 400)
      ],
      [100, 300]
    )
    // Gap 1 is after the first message and before the second.
    expect(rows.get(1)?.map((row) => row.kind)).toEqual(['started', 'received'])
    const [started, received] = rows.get(1)!
    expect(started.kind === 'started' && started.briefs.map((brief) => brief.id)).toEqual([
      'brief-a',
      'brief-b'
    ])
    expect(received.kind === 'received' && received.messages.map((entry) => entry.id)).toEqual([
      'report-a',
      'report-b'
    ])
    // A message after the last chat message lands at the end, in its own row.
    expect(rows.get(2)?.map((row) => row.kind)).toEqual(['received'])
  })

  it("leaves out a manager's own updates and shows a worker its brief and messages", () => {
    const messages = [
      message('brief', 'manager', 'worker', 'brief', 10),
      message('update', 'manager', 'worker', 'update', 50),
      message('report', 'worker', 'manager', 'report', 60)
    ]
    expect(sessionTimeline('manager', 'manager', messages, []).get(0)).toEqual([
      expect.objectContaining({ kind: 'started' }),
      expect.objectContaining({ kind: 'received' })
    ])
    const worker = sessionTimeline('worker', 'worker', messages, [20])
    expect(worker.get(0)?.map((row) => row.kind)).toEqual(['brief'])
    // Its own report is its chat's last message, not a row.
    expect(worker.get(1)?.map((row) => row.kind)).toEqual(['message'])
  })

  it('adds nothing to a chat with no family', () => {
    expect(sessionTimeline('chat', null, [message('m', 'a', 'chat', 'update', 1)], []).size).toBe(0)
  })
})
