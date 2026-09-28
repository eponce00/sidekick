import { describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent, AgentRunSurface } from '../../shared/agentRuntime'
import { ConversationAttentionTracker } from './conversationAttention'

let sequence = 0
function event(
  runId: string,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  sequence += 1
  return { id: `event-${sequence}`, runId, sequence, type, timestamp: sequence, payload }
}

function tracker(runs: Record<string, { threadId: string; surface: AgentRunSurface }>): {
  tracker: ConversationAttentionTracker
  onChange: ReturnType<typeof vi.fn>
} {
  const onChange = vi.fn()
  return {
    tracker: new ConversationAttentionTracker((runId) => runs[runId] ?? null, onChange),
    onChange
  }
}

describe('ConversationAttentionTracker', () => {
  const runs = {
    'run-a': { threadId: 'chat-a', surface: 'conversation' as const },
    'child-a': { threadId: 'chat-a', surface: 'subagent' as const },
    'run-b': { threadId: 'chat-b', surface: 'research' as const },
    'group-run': { threadId: 'session-1', surface: 'collaboration' as const }
  }

  it('marks a conversation waiting on an approval and alerts once', () => {
    const { tracker: attention, onChange } = tracker(runs)
    attention.observe(
      event('run-a', 'permission.requested', { interactionId: 'i-1', kind: 'permission' })
    )
    expect(onChange).toHaveBeenLastCalledWith({
      waitingConversationIds: ['chat-a'],
      alert: { conversationId: 'chat-a', reason: 'approval' }
    })

    // A sub-agent of the same conversation asking too does not alert again.
    attention.observe(
      event('child-a', 'question.requested', { interactionId: 'i-2', kind: 'question' })
    )
    expect(onChange).toHaveBeenLastCalledWith({ waitingConversationIds: ['chat-a'] })

    attention.observe(event('run-a', 'permission.resolved', { interactionId: 'i-1' }))
    expect(attention.state().waitingConversationIds).toEqual(['chat-a'])
    attention.observe(event('child-a', 'question.resolved', { interactionId: 'i-2' }))
    expect(onChange).toHaveBeenLastCalledWith({ waitingConversationIds: [] })
  })

  it('names questions apart from approvals, including plan and tool-limit decisions', () => {
    const { tracker: attention, onChange } = tracker(runs)
    attention.observe(
      event('run-b', 'question.requested', { interactionId: 'q', kind: 'question' })
    )
    expect(onChange.mock.lastCall?.[0].alert).toEqual({
      conversationId: 'chat-b',
      reason: 'question'
    })
    attention.observe(
      event('run-a', 'question.requested', { interactionId: 'p', kind: 'plan_approval' })
    )
    expect(onChange.mock.lastCall?.[0].alert).toEqual({
      conversationId: 'chat-a',
      reason: 'approval'
    })
    expect(attention.state().waitingConversationIds.sort()).toEqual(['chat-a', 'chat-b'])
  })

  it('ignores group sessions and unknown runs', () => {
    const { tracker: attention, onChange } = tracker(runs)
    attention.observe(
      event('group-run', 'permission.requested', { interactionId: 'g', kind: 'permission' })
    )
    attention.observe(
      event('missing', 'permission.requested', { interactionId: 'm', kind: 'permission' })
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears a run that ends while waiting, and alerts when it failed', () => {
    const { tracker: attention, onChange } = tracker(runs)
    attention.observe(
      event('run-a', 'permission.requested', { interactionId: 'i', kind: 'permission' })
    )
    attention.observe(event('run-a', 'run.completed', { phase: 'failed' }))
    expect(onChange).toHaveBeenLastCalledWith({
      waitingConversationIds: [],
      alert: { conversationId: 'chat-a', reason: 'failed' }
    })
  })

  it('does not alert for a completed run or a failed sub-agent', () => {
    const { tracker: attention, onChange } = tracker(runs)
    attention.observe(event('run-a', 'run.completed', { phase: 'completed' }))
    attention.observe(event('child-a', 'run.completed', { phase: 'failed' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
