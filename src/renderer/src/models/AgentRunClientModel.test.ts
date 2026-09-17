import { describe, expect, it, vi } from 'vitest'
import { AgentRunClientModel } from './AgentRunClientModel'
import type { AgentRunEvent } from '../../../shared/agentRuntime'

function event(sequence: number, type: AgentRunEvent['type'] = 'assistant.delta'): AgentRunEvent {
  return {
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    timestamp: sequence,
    payload: type === 'assistant.delta' ? { content: String(sequence) } : {}
  }
}

describe('AgentRunClientModel', () => {
  it('reports a live sequence gap and repairs it without duplicating events', () => {
    const model = new AgentRunClientModel()
    model.replace(null, [event(1)])
    expect(model.ingest(event(3))).toEqual({ accepted: true, gapAfter: 1 })
    model.merge(null, [event(2), event(3)])
    expect(model.getSnapshot().contiguousSequence).toBe(3)
    expect(model.getSnapshot().projection.content).toBe('123')
  })

  it('publishes identity-stable snapshots only for accepted changes', () => {
    const model = new AgentRunClientModel()
    const listener = vi.fn()
    model.subscribe(listener)
    model.replace(null, [event(1)])
    const snapshot = model.getSnapshot()
    expect(model.ingest(event(1)).accepted).toBe(false)
    expect(model.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces deferred events into one projection refresh', () => {
    const model = new AgentRunClientModel()
    const listener = vi.fn()
    model.subscribe(listener)
    model.replace(null, [event(1)])
    const before = model.getSnapshot()

    for (let sequence = 2; sequence <= 100; sequence++) {
      model.ingest(event(sequence), { deferProjection: true })
    }

    expect(model.getSnapshot()).toBe(before)
    expect(listener).toHaveBeenCalledTimes(1)
    const refreshed = model.refresh()
    expect(refreshed.highestSequence).toBe(100)
    expect(refreshed.projection.content).toBe(
      Array.from({ length: 100 }, (_, index) => String(index + 1)).join('')
    )
    expect(listener).toHaveBeenCalledTimes(2)
    expect(model.refresh()).toBe(refreshed)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
