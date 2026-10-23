import { describe, expect, it } from 'vitest'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { CompanionChat, CompanionMessage } from '../../../shared/companion'
import {
  chatBadge,
  firstGapAfter,
  insertAtCursor,
  mergeRunEvents,
  relativeTime,
  runEventAction,
  sendBaseline,
  unconfirmedSends,
  type PendingSend,
  type Segment
} from './chatState'

function event(sequence: number, type: AgentRunEvent['type'] = 'assistant.delta'): AgentRunEvent {
  return {
    id: `run-1:${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    timestamp: sequence,
    payload: {}
  }
}

function chat(extra: Partial<CompanionChat>): CompanionChat {
  return {
    id: 'c',
    title: 'Chat',
    updatedAt: 0,
    pinned: false,
    projectName: null,
    activePhase: null,
    needsAnswer: false,
    ...extra
  }
}

function userMessage(content: string): CompanionMessage {
  return { id: content, role: 'user', content, timestamp: 0 }
}

describe('mergeRunEvents', () => {
  it('adds new events in sequence order', () => {
    const merged = mergeRunEvents([event(1), event(3)], [event(2), event(4)])
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3, 4])
  })

  it('drops events already seen by id or by sequence', () => {
    const current = [event(1), event(2)]
    const replay = { ...event(2), id: 'another-id' }
    expect(mergeRunEvents(current, [event(1), replay])).toBe(current)
  })

  it('keeps one copy of an event that arrives twice in the same batch', () => {
    expect(mergeRunEvents([], [event(1), event(1)])).toHaveLength(1)
  })
})

describe('firstGapAfter', () => {
  it('finds the last event before missing ones', () => {
    expect(firstGapAfter([event(1), event(2), event(5), event(6)])).toBe(2)
  })

  it('is null for contiguous events, and ignores a run whose start was not loaded', () => {
    expect(firstGapAfter([event(1), event(2), event(3)])).toBeNull()
    expect(firstGapAfter([event(4), event(5)])).toBeNull()
    expect(firstGapAfter([])).toBeNull()
  })
})

describe('runEventAction', () => {
  it('reloads when a new run starts in the open chat', () => {
    const started = { ...event(1, 'run.started'), runId: 'run-2', payload: { threadId: 'chat-a' } }
    expect(runEventAction(started, 'chat-a', 'run-1')).toBe('reload')
    expect(runEventAction(started, 'chat-a', null)).toBe('reload')
  })

  it('ignores runs of other chats and sub-agents', () => {
    const other = { ...event(1, 'run.started'), runId: 'run-2', payload: { threadId: 'chat-b' } }
    const child = {
      ...event(1, 'run.started'),
      runId: 'run-3',
      payload: { threadId: 'chat-a', parentRunId: 'run-1' }
    }
    expect(runEventAction(other, 'chat-a', null)).toBe('ignore')
    expect(runEventAction(child, 'chat-a', 'run-1')).toBe('ignore')
    expect(runEventAction(event(4), 'chat-a', 'run-9')).toBe('ignore')
  })

  it('appends events of the run that is shown', () => {
    expect(runEventAction(event(4), 'chat-a', 'run-1')).toBe('append')
  })
})

describe('chatBadge', () => {
  it('prefers a waiting card to a working run', () => {
    expect(chatBadge(chat({ activePhase: 'awaiting_user', needsAnswer: true }))).toBe('answer')
    expect(chatBadge(chat({ activePhase: 'streaming' }))).toBe('working')
    expect(chatBadge(chat({ activePhase: 'completed' }))).toBeNull()
    expect(chatBadge(chat({}))).toBeNull()
  })
})

describe('relativeTime', () => {
  const now = new Date(2026, 5, 15, 12).getTime()
  it('gives short ages', () => {
    expect(relativeTime(now - 10_000, now)).toBe('now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d')
  })

  it('treats a clock ahead of the phone as now', () => {
    expect(relativeTime(now + 60_000, now)).toBe('now')
  })
})

describe('sent messages', () => {
  it('stay shown until the computer has one more copy of the text', () => {
    const pending: PendingSend[] = [{ id: 's1', text: 'yes', sentAt: 0, baseline: 1 }]
    const before = [userMessage('yes')]
    expect(unconfirmedSends(pending, before, [])).toHaveLength(1)
    expect(unconfirmedSends(pending, [...before, userMessage('yes')], [])).toHaveLength(0)
  })

  it('count a message the run took in while it worked', () => {
    const pending: PendingSend[] = [{ id: 's1', text: 'also check logs', sentAt: 0, baseline: 0 }]
    const steer: Segment = {
      type: 'steer',
      steer: { id: 'm', content: 'also check logs', timestamp: 0 }
    }
    expect(unconfirmedSends(pending, [], [steer])).toHaveLength(0)
  })

  it('count a message a finished reply took in', () => {
    const pending: PendingSend[] = [{ id: 's1', text: 'and a steer', sentAt: 0, baseline: 0 }]
    const reply: CompanionMessage = {
      id: 'r',
      role: 'assistant',
      content: 'done',
      timestamp: 0,
      segments: [{ type: 'steer', steer: { id: 'm', content: 'and a steer', timestamp: 0 } }]
    }
    expect(unconfirmedSends(pending, [reply], [])).toHaveLength(0)
  })

  it('give a repeated text its own place in line', () => {
    const first: PendingSend = {
      id: 's1',
      text: 'ok',
      sentAt: 0,
      baseline: sendBaseline('ok', [], [], [])
    }
    const second: PendingSend = {
      id: 's2',
      text: 'ok',
      sentAt: 0,
      baseline: sendBaseline('ok', [], [], [first])
    }
    expect(second.baseline).toBe(1)
    // The first arrived; the second is still on its way.
    expect(unconfirmedSends([first, second], [userMessage('ok')], [])).toEqual([second])
  })
})

describe('insertAtCursor', () => {
  it('puts dictated words at the cursor with a space on each side', () => {
    expect(insertAtCursor('Draft it and', 12, 12, 'send it')).toEqual({
      value: 'Draft it and send it',
      cursor: 20
    })
    expect(insertAtCursor('Fix  please', 4, 4, 'the build')).toEqual({
      value: 'Fix the build please',
      cursor: 13
    })
  })

  it('replaces a selection and fills an empty box', () => {
    expect(insertAtCursor('Fix the tests', 4, 7, 'every')).toEqual({
      value: 'Fix every tests',
      cursor: 9
    })
    expect(insertAtCursor('', 0, 0, 'Hello')).toEqual({ value: 'Hello', cursor: 5 })
  })
})
