import type { ProjectedContentSegment } from '../../../shared/agentEventProjection'
import type { AgentRunEvent, AgentRunPhase } from '../../../shared/agentRuntime'
import type { CompanionChat, CompanionMessage } from '../../../shared/companion'
import type { AgentPermissionDecision } from '../../../shared/permissions'
import type { CompanionClient } from './companionClient'

/** What the phone needs from a connection; the preview client offers the same. */
export type CompanionConnection = Pick<CompanionClient, 'call' | 'listen' | 'close'>

export type Segment = ProjectedContentSegment
export type InteractionSegment = Extract<Segment, { type: 'interaction' }>
export type Interaction = InteractionSegment['interaction']
export type ToolSegment = Extract<Segment, { type: 'tool' }>

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
  /** How many copies of this text the chat already showed when it was sent. */
  baseline: number
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

/** Saved segments come from storage, so only the shapes this page draws are kept. */
export function savedSegments(value: unknown[] | undefined): Segment[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Segment => {
    if (!isRecord(item)) return false
    switch (item.type) {
      case 'text':
      case 'thinking':
        return typeof item.content === 'string'
      case 'tool':
        return isRecord(item.tool) && typeof item.tool.title === 'string'
      case 'interaction':
        return (
          isRecord(item.interaction) &&
          typeof item.interaction.id === 'string' &&
          isRecord(item.interaction.request)
        )
      case 'run_error':
        return isRecord(item.runError) && typeof item.runError.message === 'string'
      case 'run_status':
        return isRecord(item.status)
      case 'steer':
        return isRecord(item.steer) && typeof item.steer.content === 'string'
      case 'artifact':
        return isRecord(item.artifact) && typeof item.artifact.title === 'string'
      case 'summary':
      case 'verification':
      case 'decision':
        return true
      default:
        return false
    }
  })
}

export interface QuestionOption {
  label: string
  description?: string
  recommended?: boolean
}

export interface Question {
  id: string
  header?: string
  question: string
  options?: QuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

export interface QuestionAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

export const EMPTY_ANSWER: QuestionAnswer = { selected: [], custom: '', skipped: false }

export function questionsFrom(request: Record<string, unknown>): Question[] {
  if (!Array.isArray(request.questions)) return []
  return request.questions.filter(
    (question): question is Question =>
      isRecord(question) && typeof question.id === 'string' && typeof question.question === 'string'
  )
}

/** The answers as the desktop sends them: one string, or a list for several choices. */
export function questionResponse(
  questions: readonly Question[],
  answers: Readonly<Record<string, QuestionAnswer>>
): Record<string, string | string[]> {
  const response: Record<string, string | string[]> = {}
  for (const question of questions) {
    const answer = answers[question.id] ?? EMPTY_ANSWER
    if (answer.skipped) continue
    const custom = answer.custom.trim()
    const values = [...answer.selected, ...(custom ? [custom] : [])]
    if (!values.length) continue
    response[question.id] = question.multiSelect || values.length > 1 ? values : values[0]
  }
  return response
}

/** Cards that need the computer itself, such as taking over its browser. */
export function answerableOnPhone(interaction: Interaction): boolean {
  return !(
    interaction.kind === 'question' &&
    (interaction.request.intent === 'start_sessions' ||
      interaction.request.intent === 'browser_takeover')
  )
}

const PREVIEW_LIMIT = 600

/** What a permission card shows of the action's arguments. */
export function permissionPreview(request: Record<string, unknown>): string {
  const args = request.arguments
  if (args === undefined || args === null) return ''
  let text: string
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args, null, 2)
  } catch {
    return ''
  }
  if (!text || text === '{}') return ''
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
}

export const PERMISSION_DECISION_LABELS: Record<AgentPermissionDecision, string> = {
  allow_once: 'Allowed once',
  allow_chat: 'Allowed for this chat',
  deny: 'Denied',
  deny_stop: 'Denied and stopped'
}

/** The text a tool row expands to: what ran, then how it ended. */
export function toolDetail(tool: ToolSegment['tool']): string {
  const lines: string[] = []
  if (tool.command && tool.command !== tool.title) lines.push(tool.command)
  if (tool.input && Object.keys(tool.input).length) {
    try {
      const input = JSON.stringify(tool.input, null, 2)
      lines.push(input.length > PREVIEW_LIMIT ? `${input.slice(0, PREVIEW_LIMIT)}…` : input)
    } catch {
      /* An input that cannot be shown is left out. */
    }
  }
  if (tool.error) lines.push(tool.error)
  else if (tool.output) {
    const output = tool.output.trim()
    lines.push(output.length > PREVIEW_LIMIT ? `${output.slice(0, PREVIEW_LIMIT)}…` : output)
  }
  return lines.join('\n\n')
}
