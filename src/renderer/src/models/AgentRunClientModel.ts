import {
  projectAgentRunEvents,
  type ProjectedAgentRunMessage
} from '../../../shared/agentEventProjection'
import type { AgentRunEvent, AgentRunSnapshot } from '../../../shared/agentRuntime'

export interface AgentRunClientSnapshot {
  run: AgentRunSnapshot | null
  events: readonly AgentRunEvent[]
  projection: ProjectedAgentRunMessage
  contiguousSequence: number
  highestSequence: number
}

const EMPTY_PROJECTION = projectAgentRunEvents([])

/**
 * React-free mirror of one authoritative main-process run journal.
 *
 * Live IPC is best effort. Sequence gaps are retained and reported so the owner
 * can repair them through the durable `events(afterSequence)` endpoint.
 */
export class AgentRunClientModel {
  private run: AgentRunSnapshot | null = null
  private readonly eventsBySequence = new Map<number, AgentRunEvent>()
  private listeners = new Set<() => void>()
  private current: AgentRunClientSnapshot = {
    run: null,
    events: [],
    projection: EMPTY_PROJECTION,
    contiguousSequence: 0,
    highestSequence: 0
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AgentRunClientSnapshot => this.current

  replace(run: AgentRunSnapshot | null, events: readonly AgentRunEvent[]): void {
    this.run = run
    this.eventsBySequence.clear()
    for (const event of events) this.accept(event)
    this.publish()
  }

  ingest(event: AgentRunEvent): { accepted: boolean; gapAfter?: number } {
    if (this.run && event.runId !== this.run.id) return { accepted: false }
    if (this.eventsBySequence.has(event.sequence)) return { accepted: false }
    const contiguousBefore = this.contiguousSequence()
    this.accept(event)
    this.publish()
    return event.sequence > contiguousBefore + 1
      ? { accepted: true, gapAfter: contiguousBefore }
      : { accepted: true }
  }

  merge(run: AgentRunSnapshot | null, events: readonly AgentRunEvent[]): void {
    if (run) this.run = run
    let changed = false
    for (const event of events) {
      if (this.eventsBySequence.has(event.sequence)) continue
      this.accept(event)
      changed = true
    }
    if (changed || run) this.publish()
  }

  private accept(event: AgentRunEvent): void {
    this.eventsBySequence.set(event.sequence, event)
  }

  private contiguousSequence(): number {
    let sequence = 0
    while (this.eventsBySequence.has(sequence + 1)) sequence++
    return sequence
  }

  private publish(): void {
    const events = [...this.eventsBySequence.values()].sort(
      (left, right) => left.sequence - right.sequence
    )
    this.current = {
      run: this.run,
      events,
      projection: projectAgentRunEvents(events),
      contiguousSequence: this.contiguousSequence(),
      highestSequence: events.at(-1)?.sequence ?? 0
    }
    for (const listener of this.listeners) listener()
  }
}
