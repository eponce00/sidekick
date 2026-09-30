// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { ToolExecution } from '../types/chat.types'
import { SubAgentCard } from './SubAgentCard'
import { SubAgentNavigation } from './subAgentNavigation'

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
  input: {
    description: 'Research the listing',
    task: 'Find the sale history of 1845 Elmcrest Dr. Cite each source.'
  },
  data: { childRunId: 'child-1' }
}

describe('SubAgentCard', () => {
  let container: HTMLDivElement
  let root: Root
  let publish: ((change: { event: AgentRunEvent }) => void) | undefined
  const stop = vi.fn(async () => ({ stopped: true }))
  const resolveInteraction = vi.fn(async () => ({ success: true }))
  const open = vi.fn()

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
    await act(async () =>
      root.render(
        <SubAgentNavigation.Provider value={open}>
          <SubAgentCard tool={tool} />
        </SubAgentNavigation.Provider>
      )
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
  }

  const text = (selector: string): string | undefined =>
    container.querySelector(selector)?.textContent ?? undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    stop.mockClear()
    resolveInteraction.mockClear()
    open.mockClear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('names the task and follows what the sub-agent is doing live', async () => {
    await mount([
      event(1, 'run.started', {}),
      event(2, 'tool.pending', { toolCallId: 't1', name: 'web_fetch' }),
      event(3, 'tool.running', { toolCallId: 't1', name: 'web_fetch', title: 'Read zillow.com' })
    ])
    expect(text('.sa-card__title')).toBe('Research the listing')
    expect(text('.sa-card__detail')).toBe('Read zillow.com')
    expect(text('.sa-card__stats')).toMatch(/^1 tool · \d+s$/)

    // A new event from the sub-agent updates the row without reloading.
    await act(async () => {
      publish?.({ event: event(4, 'tool.pending', { toolCallId: 't2', name: 'web_search' }) })
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(text('.sa-card__stats')).toMatch(/^2 tools/)

    await act(async () => container.querySelector<HTMLButtonElement>('.sa-card__stop')?.click())
    expect(stop).toHaveBeenCalledWith('child-1')
  })

  it('opens the sub-agent in its own view', async () => {
    await mount([event(1, 'run.started', {})])
    await act(async () => container.querySelector<HTMLButtonElement>('.sa-card__main')?.click())
    expect(open).toHaveBeenCalledWith({
      runId: 'child-1',
      title: 'Research the listing',
      task: 'Find the sale history of 1845 Elmcrest Dr. Cite each source.',
      context: undefined
    })
  })

  it('shows what the sub-agent needs from the user under its row', async () => {
    await mount([
      event(1, 'run.started', {}),
      event(2, 'question.requested', {
        interactionId: 'q1',
        kind: 'question',
        request: { questions: [{ id: 'county', question: 'Which county records?' }] }
      })
    ])
    expect(container.querySelector('.sa-card')?.classList.contains('is-waiting')).toBe(true)
    expect(text('.sa-card__detail')).toBe('Needs your answer below')
    expect(text('.sa-card__request')).toContain('Which county records?')
  })

  it('flags a working sub-agent that has produced nothing for minutes', async () => {
    const long = Date.now() - 6 * 60_000
    await mount([
      event(1, 'run.started', {}, long),
      event(2, 'tool.pending', { toolCallId: 't1', name: 'web_fetch' }, long),
      event(3, 'tool.running', { toolCallId: 't1', name: 'web_fetch', title: 'Read a page' }, long)
    ])
    expect(text('.sa-card__quiet')).toBe(' · No activity for 6 min')
  })

  it('leads a finished row with the start of the report and its stats', async () => {
    await mount([], {
      ...runningTool,
      status: 'success',
      data: {
        childRunId: 'child-1',
        status: 'completed',
        content: '**Reno — 4,505 ft** (1,373 m), per USGS GNIS.\n\nCarson City — 4,682 ft.',
        toolCalls: 99,
        durationMs: 3_288_000
      }
    })
    expect(container.querySelector('.sa-card')?.classList.contains('is-done')).toBe(true)
    expect(text('.sa-card__detail')).toBe('Reno — 4,505 ft (1,373 m), per USGS GNIS.')
    expect(text('.sa-card__stats')).toBe('99 tools · 54m 48s')
    expect(container.querySelector('.sa-card__stop')).toBeNull()
  })

  it('reads a sub-agent stopped with its chat as stopped, not as raw tool data', async () => {
    await mount([], {
      ...runningTool,
      input: { task: 'Find the elevation of Reno. Use primary sources.' },
      status: 'error',
      error: 'Tool execution was cancelled',
      output: '{"ok":false,"code":"cancelled"}',
      data: undefined
    })
    expect(text('.sa-card__title')).toBe('Find the elevation of Reno.')
    expect(text('.sa-card__detail')).toBe('Stopped before it reported')
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
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.sa-card__decision button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Let it continue', 'Stop it'])
    await act(async () => buttons[0].click())
    expect(resolveInteraction).toHaveBeenCalledWith({
      interactionId: 'limit-1',
      response: { approved: true },
      cancelled: undefined
    })
  })
})
