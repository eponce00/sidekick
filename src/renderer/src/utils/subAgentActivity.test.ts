import { describe, expect, it } from 'vitest'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import { subAgentActivity, subAgentResultSummary, subAgentSteps } from './subAgentActivity'

function event(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  return {
    id: `e-${sequence}`,
    runId: 'child-1',
    sequence,
    type,
    payload,
    timestamp: sequence * 1000
  }
}

const activity = (events: AgentRunEvent[]): ReturnType<typeof subAgentActivity> =>
  subAgentActivity(events, projectAgentRunEvents(events))

describe('subAgentActivity', () => {
  const working = [
    event(1, 'run.started', {}),
    event(2, 'tool.pending', { toolCallId: 't1', name: 'web_search' }),
    event(3, 'tool.running', { toolCallId: 't1', name: 'web_search', title: 'Search Elmcrest Dr' }),
    event(4, 'assistant.completed', { content: '', toolCalls: [{ id: 't1' }] })
  ]

  it('says what a working sub-agent is doing and since when it has been quiet', () => {
    expect(activity(working)).toEqual({
      state: 'working',
      startedAt: 1000,
      endedAt: undefined,
      lastActivityAt: 4000,
      toolCalls: 1,
      current: 'Search Elmcrest Dr'
    })
  })

  it('shows a sub-agent paused on a question as waiting on the user', () => {
    const waiting = [
      ...working,
      event(5, 'question.requested', {
        interactionId: 'q1',
        kind: 'question',
        request: { question: 'Which county?' }
      })
    ]
    expect(activity(waiting)).toMatchObject({ state: 'waiting', current: 'Waiting on you' })
  })

  it('settles as done, failed or stopped when the run ends', () => {
    for (const [phase, state] of [
      ['completed', 'done'],
      ['failed', 'failed'],
      ['cancelled', 'stopped']
    ] as const) {
      const ended = [...working, event(9, 'run.completed', { phase })]
      expect(activity(ended)).toMatchObject({ state, endedAt: 9000, current: undefined })
    }
  })

  it('says it is thinking between tools rather than naming the last finished one', () => {
    const thinking = [
      ...working,
      event(5, 'tool.completed', {
        toolCallId: 't1',
        result: {
          status: 'success',
          title: 'Search Elmcrest Dr',
          modelContent: 'results',
          timing: { startedAt: 3000, completedAt: 5000 }
        }
      }),
      event(6, 'run.phase', { phase: 'streaming' }),
      event(7, 'assistant.delta', { thinking: 'Comparing the listings' })
    ]
    expect(activity(thinking).current).toBe('Thinking')
  })

  it('reads a finished result as a sentence', () => {
    expect(
      subAgentResultSummary({ childRunId: 'c', status: 'cancelled', content: '\n\nReno: 264,165.' })
    ).toBe('Stopped — Reno: 264,165.')
    expect(subAgentResultSummary({ status: 'failed', error: 'HTTP 502' })).toBe('Failed — HTTP 502')
    expect(subAgentResultSummary({ output: 'something else' })).toBeUndefined()
  })

  it('lists its steps as a transcript', () => {
    const steps = subAgentSteps(
      projectAgentRunEvents([
        event(1, 'assistant.delta', { thinking: 'Plan it' }),
        ...working.slice(1),
        event(5, 'assistant.delta', { content: 'Found the listing.' }),
        event(6, 'assistant.completed', { content: 'Found the listing.' })
      ])
    )
    expect(steps.map((step) => step.type)).toEqual(['thinking', 'tool_call', 'response'])
  })
})
