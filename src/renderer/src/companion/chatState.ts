import type { ProjectedContentSegment } from '../../../shared/agentEventProjection'
import type { AgentRunEvent, AgentRunPhase } from '../../../shared/agentRuntime'
import type { CompanionChat, CompanionImage, CompanionMessage } from '../../../shared/companion'
import type { CompanionClient } from './companionClient'

/** What the phone needs from a connection; the preview client offers the same. */
export type CompanionConnection = Pick<CompanionClient, 'call' | 'listen' | 'close'>

export type Segment = ProjectedContentSegment

const FINISHED_PHASES: ReadonlySet<AgentRunPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export function isActivePhase(phase: AgentRunPhase | null | undefined): boolean {
  return Boolean(phase && !FINISHED_PHASES.has(phase))
}

/** The list badge: a waiting card matters more than a run that is still working. */
export function chatBadge(chat: CompanionChat): 'answer' | 'working' | null {
  if (chat.needsAnswer) return 'answer'
  return isActivePhase(chat.activePhase) ? 'working' : null
}

/** A short age for the chat list: now, 5m, 3h, 2d, then the date. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const date = new Date(timestamp)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' })
  })
}

/** Adds events to a run once each, in sequence order; returns the same array when nothing is new. */
export function mergeRunEvents(
  current: readonly AgentRunEvent[],
  incoming: readonly AgentRunEvent[]
): AgentRunEvent[] {
  const ids = new Set(current.map((event) => event.id))
  const sequences = new Set(current.map((event) => event.sequence))
  const added: AgentRunEvent[] = []
  for (const event of incoming) {
    if (ids.has(event.id) || sequences.has(event.sequence)) continue
    ids.add(event.id)
    sequences.add(event.sequence)
    added.push(event)
  }
  if (!added.length) return current as AgentRunEvent[]
  return [...current, ...added].sort((left, right) => left.sequence - right.sequence)
}

/**
 * The sequence after which events are missing, or null when the run's events are contiguous.
 * Only holes between known events count: the stream can drop events, but the run's start is
 * always in what the chat loaded.
 */
export function firstGapAfter(events: readonly AgentRunEvent[]): number | null {
  for (let index = 1; index < events.length; index++) {
    if (events[index].sequence > events[index - 1].sequence + 1) return events[index - 1].sequence
  }
  return null
}

/** What an event pushed by the computer means for the chat that is open. */
export function runEventAction(
  event: AgentRunEvent,
  conversationId: string | null,
  runId: string | null
): 'reload' | 'append' | 'ignore' {
  if (
    event.type === 'run.started' &&
    conversationId &&
    event.payload.threadId === conversationId &&
    !event.payload.parentRunId
  ) {
    return event.runId === runId ? 'append' : 'reload'
  }
  return runId && event.runId === runId ? 'append' : 'ignore'
}

/** A message sent from this phone, shown until the computer's copy of it arrives. */
export interface PendingSend {
  id: string
  text: string
  sentAt: number
  /** How many copies of this text the chat already showed when it was sent. */
  baseline: number
  images?: CompanionImage[]
  /** Names of the text files sent with it. */
  files?: string[]
}

/**
 * How many times the user said exactly this: as a message, or taken in by a run while it worked,
 * which a finished reply keeps among its segments.
 */
export function countUserText(
  text: string,
  messages: readonly CompanionMessage[],
  liveSegments: readonly Segment[]
): number {
  const wanted = text.trim()
  const steers = (segments: readonly unknown[]): number =>
    segments.filter((segment) => {
      const steer = isRecord(segment) && segment.type === 'steer' ? segment.steer : null
      return isRecord(steer) && typeof steer.content === 'string' && steer.content.trim() === wanted
    }).length
  let count = steers(liveSegments)
  for (const message of messages) {
    if (message.role === 'user' && message.content.trim() === wanted) count++
    else if (message.role === 'assistant' && Array.isArray(message.segments))
      count += steers(message.segments)
  }
  return count
}

/** The sent messages the computer has not shown back yet. */
export function unconfirmedSends(
  pending: readonly PendingSend[],
  messages: readonly CompanionMessage[],
  liveSegments: readonly Segment[]
): PendingSend[] {
  return pending.filter((send) => countUserText(send.text, messages, liveSegments) <= send.baseline)
}

/** The baseline for a new send: copies already shown plus copies still on their way. */
export function sendBaseline(
  text: string,
  messages: readonly CompanionMessage[],
  liveSegments: readonly Segment[],
  pending: readonly PendingSend[]
): number {
  const waiting = unconfirmedSends(pending, messages, liveSegments).filter(
    (send) => send.text.trim() === text.trim()
  ).length
  return countUserText(text, messages, liveSegments) + waiting
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Puts dictated words where the cursor is, replacing any selection, with a space between them and
 * the text around them; returns the new text and where the cursor goes.
 */
export function insertAtCursor(
  value: string,
  start: number,
  end: number,
  words: string
): { value: string; cursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const inserted = `${lead}${words}${trail}`
  return { value: before + inserted + after, cursor: before.length + lead.length + words.length }
}
