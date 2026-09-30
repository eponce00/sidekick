import { describe, expect, it } from 'vitest'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import { subAgentActivity, subAgentOutcome } from './subAgentActivity'

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

  it('says it is writing its report once text follows the last tool', () => {
    const writing = [
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
      event(6, 'assistant.delta', { content: 'Reno sits at' })
    ]
    expect(activity(writing).current).toBe('Writing its report')
  })
})

describe('subAgentOutcome', () => {
  it('leads with the first line of the report, without its markdown', () => {
    expect(
      subAgentOutcome({
        childRunId: 'c',
        status: 'completed',
        content: '\n\n## **Reno, Nevada — 4,505 ft** (1,373 m)\n- GNIS 861100',
        toolCalls: 99,
        durationMs: 3_288_000
      })
    ).toEqual({
      state: 'done',
      headline: 'Reno, Nevada — 4,505 ft (1,373 m)',
      toolCalls: 99,
      durationMs: 3_288_000
    })
  })

  it('reads an older result, which carried every turn, by its final report', () => {
    const content =
      "\n\nI'll research this from primary sources.\n\n\n\n\nFound the record URL format." +
      '\n\n\n\n\n## Reno, Nevada\n- **Elevation:** 4,505 ft (1,373 m)\n- Source: USGS GNIS'
    expect(subAgentOutcome({ status: 'completed', content })?.headline).toBe(
      'Reno, Nevada · Elevation: 4,505 ft (1,373 m)'
    )
  })

  it('leads with the reason when it did not finish', () => {
    expect(subAgentOutcome({ status: 'failed', error: 'HTTP 502', content: 'Partial' })).toEqual(
      expect.objectContaining({ state: 'failed', headline: 'HTTP 502' })
    )
    expect(subAgentOutcome({ status: 'cancelled', content: '' })).toEqual(
      expect.objectContaining({ state: 'stopped', headline: undefined })
    )
  })

  it('is undefined for anything that is not a finished sub-agent', () => {
    expect(subAgentOutcome({ output: 'something else' })).toBeUndefined()
    expect(subAgentOutcome(null)).toBeUndefined()
  })
})
