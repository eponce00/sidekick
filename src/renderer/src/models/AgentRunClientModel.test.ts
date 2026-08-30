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
})
