// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { ToolExecution } from '../types/chat.types'
import { SubAgentCard } from './SubAgentCard'

function event(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>,
  timestamp = Date.now()
): AgentRunEvent {
  return { id: `e-${sequence}`, runId: 'child-1', sequence, type, payload, timestamp }
}

const runningTool: ToolExecution = {
  id: 'spawn-1',
  title: 'Delegate task',
  command: '',
  name: 'spawn_subagent',
  status: 'running',
  data: { childRunId: 'child-1' }
}

describe('SubAgentCard', () => {
  let container: HTMLDivElement
  let root: Root
  let publish: ((change: { event: AgentRunEvent }) => void) | undefined
  const stop = vi.fn(async () => ({ stopped: true }))
  const resolveInteraction = vi.fn(async () => ({ success: true }))

  const mount = async (events: AgentRunEvent[], tool = runningTool): Promise<void> => {
    Object.assign(window, {
      api: {
        agentRuns: {
          events: vi.fn(async () => ({ run: null, events, pendingInteractions: [] })),
          onEvent: vi.fn((callback: typeof publish) => {
            publish = callback
            return () => (publish = undefined)
          }),
          stop,
          resolveInteraction
        }
      }
    })
    await act(async () => root.render(<SubAgentCard tool={tool} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    stop.mockClear()
    resolveInteraction.mockClear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('follows a working sub-agent live and can stop just the sub-agent', async () => {
    await mount([
      event(1, 'run.started', {}),
      event(2, 'tool.pending', { toolCallId: 't1', name: 'web_fetch' }),
      event(3, 'tool.running', { toolCallId: 't1', name: 'web_fetch', title: 'Read zillow.com' })
    ])
    const status = container.querySelector('.sa-inline__status')
    expect(status?.textContent).toContain('Working')
    expect(status?.textContent).toContain('1 tool')
    expect(status?.textContent).toContain('Read zillow.com')

    // A new event from the sub-agent updates the line without reloading.
    await act(async () => {
      publish?.({
        event: event(4, 'tool.pending', { toolCallId: 't2', name: 'web_search' })
      })
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(container.querySelector('.sa-inline__status')?.textContent).toContain('2 tools')

    const stopButton = container.querySelector<HTMLButtonElement>('.sa-inline__stop')
    await act(async () => stopButton?.click())
    expect(stop).toHaveBeenCalledWith('child-1')
  })

  it('shows what the sub-agent needs from the user, and says when it has gone quiet', async () => {
    const long = Date.now() - 10 * 60_000
    await mount([
      event(1, 'run.started', {}, long),
      event(
        2,
        'question.requested',
        {
          interactionId: 'q1',
          kind: 'question',
          request: { questions: [{ id: 'county', question: 'Which county records?' }] }
        },
        long
      )
    ])
    expect(container.querySelector('.sa-inline__status')?.textContent).toContain('Waiting on you')
    expect(container.querySelector('.sa-inline__interaction')?.textContent).toContain(
      'Which county records?'
    )
  })

  it('flags a working sub-agent that has produced nothing for minutes', async () => {
    const long = Date.now() - 6 * 60_000
    await mount([
      event(1, 'run.started', {}, long),
      event(2, 'tool.pending', { toolCallId: 't1', name: 'web_fetch' }, long),
      event(3, 'tool.running', { toolCallId: 't1', name: 'web_fetch', title: 'Read a page' }, long)
    ])
    expect(container.querySelector('.sa-inline__quiet')?.textContent).toBe('No activity for 6 min')
  })

  it('reads a sub-agent stopped with its chat as stopped, not as raw tool data', async () => {
    await mount([], {
      ...runningTool,
      title: 'spawn subagent',
      status: 'error',
      error: 'Tool execution was cancelled',
      output: '{"ok":false,"code":"cancelled"}',
      data: undefined
    })
    expect(container.querySelector('.sa-inline__summary')?.textContent).toBe('Stopped')
    expect(container.textContent).toContain('Delegate task')
    expect(container.textContent).not.toContain('"ok":false')
  })

  it('offers an answer to a tool-limit question left by an older sub-agent', async () => {
    await mount([
      event(1, 'run.started', {}),
      event(2, 'question.requested', {
        interactionId: 'limit-1',
        kind: 'tool_limit',
        request: { roundsUsed: 80, requestedAdditionalRounds: 40 }
      })
    ])
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>('.sa-inline__decision button')
    ]
    expect(buttons.map((button) => button.textContent)).toEqual(['Let it continue', 'Stop it'])
    await act(async () => buttons[0].click())
    expect(resolveInteraction).toHaveBeenCalledWith({
      interactionId: 'limit-1',
      response: { approved: true },
      cancelled: undefined
    })
  })
})
