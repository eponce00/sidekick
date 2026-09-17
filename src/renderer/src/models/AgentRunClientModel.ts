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
  private projectionDirty = false
  private contiguous = 0
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
    this.contiguous = 0
    for (const event of events) this.accept(event)
    this.publish()
  }

  ingest(
    event: AgentRunEvent,
    options: { deferProjection?: boolean } = {}
  ): { accepted: boolean; gapAfter?: number } {
    if (this.run && event.runId !== this.run.id) return { accepted: false }
    if (this.eventsBySequence.has(event.sequence)) return { accepted: false }
    const contiguousBefore = this.contiguous
    this.accept(event)
    if (options.deferProjection) this.projectionDirty = true
    else this.publish()
    return event.sequence > contiguousBefore + 1
      ? { accepted: true, gapAfter: contiguousBefore }
      : { accepted: true }
  }

  merge(
    run: AgentRunSnapshot | null,
    events: readonly AgentRunEvent[],
    options: { deferProjection?: boolean } = {}
  ): void {
    if (run) this.run = run
    let changed = false
    for (const event of events) {
      if (this.eventsBySequence.has(event.sequence)) continue
      this.accept(event)
      changed = true
    }
    if (changed || run) {
      if (options.deferProjection) this.projectionDirty = true
      else this.publish()
    }
  }

  /**
   * Rebuild the human projection once at the renderer's scheduled frame boundary.
   * Durable events still enter the journal immediately, but token deltas no longer
   * re-sort and re-project the entire run hundreds of times per second.
   */
  refresh(): AgentRunClientSnapshot {
    if (this.projectionDirty) this.publish()
    return this.current
  }

  private accept(event: AgentRunEvent): void {
    this.eventsBySequence.set(event.sequence, event)
    while (this.eventsBySequence.has(this.contiguous + 1)) this.contiguous++
  }

  private publish(): void {
    const events = [...this.eventsBySequence.values()].sort(
      (left, right) => left.sequence - right.sequence
    )
    this.current = {
      run: this.run,
      events,
      projection: projectAgentRunEvents(events),
      contiguousSequence: this.contiguous,
      highestSequence: events.at(-1)?.sequence ?? 0
    }
    this.projectionDirty = false
    for (const listener of this.listeners) listener()
  }
}
