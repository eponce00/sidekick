import type { ProjectedAgentRunMessage } from '../../../shared/agentEventProjection'
import type { AgentRunEvent } from '../../../shared/agentRuntime'

export type SubAgentState = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'

export interface SubAgentActivity {
  state: SubAgentState
  startedAt?: number
  endedAt?: number
  /** When the sub-agent last produced anything, so a stall is visible. */
  lastActivityAt?: number
  toolCalls: number
  /** What it is doing right now, in a few words. */
  current?: string
}

/** How a finished sub-agent ended, from the delegating tool's result. */
export interface SubAgentOutcome {
  state: Exclude<SubAgentState, 'working' | 'waiting'>
  /** The first line of its report, or why it failed. */
  headline?: string
  toolCalls?: number
  durationMs?: number
}

// A sub-agent this quiet has usually stalled, rather than being in a long step.
export const SUB_AGENT_QUIET_MS = 3 * 60_000

const TERMINAL_STATES: Record<string, SubAgentOutcome['state']> = {
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'stopped'
}

function clip(text: string, length = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat
}

/** The first line a reader would take as the report's point, without markdown decoration. */
function headline(content: string): string | undefined {
  // Results from before the report was returned on its own carry every turn's
  // text, turns set apart by runs of blank lines; the report is the last.
  const report =
    content
      .split(/\n{3,}/)
      .filter((part) => part.trim())
      .at(-1) ?? ''
  const lines = report
    .split('\n')
    .map((text) => ({
      heading: /^#+\s/.test(text.trim()),
      text: text
        .replace(/^\s*#+\s*|^\s*[-*>]\s+|\*\*|__|`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim()
    }))
    .filter((line) => line.text)
  const [first, second] = lines
  if (!first) return undefined
  // A short heading says little alone ("Reno, Nevada"); the line under it carries the point.
  const text =
    first.heading && second && first.text.length < 25
      ? `${first.text} · ${second.text}`
      : first.text
  return clip(text, 160)
}

/** The sub-agent's state and latest step, from its own run journal. */
export function subAgentActivity(
  events: readonly AgentRunEvent[],
  projection: ProjectedAgentRunMessage
): SubAgentActivity {
  const tools = new Set<string>()
  let startedAt: number | undefined
  let endedAt: number | undefined
  for (const event of events) {
    startedAt ??= event.timestamp
    if (event.type === 'tool.pending') tools.add(String(event.payload.toolCallId || event.id))
    if (event.type === 'run.completed') endedAt = event.timestamp
  }
  const waiting = projection.segments.some(
    (segment) =>
      (segment.type === 'interaction' && segment.interaction.status === 'pending') ||
      (segment.type === 'decision' && segment.decision.status === 'pending')
  )
  const phase = projection.phase ?? ''
  // A running phase has no entry, though the record's type does not say so.
  const ended = TERMINAL_STATES[phase] as SubAgentState | undefined
  const state: SubAgentState = ended ?? (waiting ? 'waiting' : 'working')

  let current: string | undefined
  if (state === 'waiting') current = 'Waiting on you'
  else if (state === 'working') {
    const running = [...projection.segments]
      .reverse()
      .find(
        (segment) =>
          segment.type === 'tool' &&
          (segment.tool.status === 'running' || segment.tool.status === 'pending')
      )
    const last = projection.segments.at(-1)
    // Between tools the model is reasoning; the last finished tool is not what it is doing.
    current =
      running?.type === 'tool'
        ? clip(running.tool.title)
        : last?.type === 'text' && last.content.trim()
          ? 'Writing its report'
          : events.length
            ? 'Thinking'
            : 'Starting'
  }

  return {
    state,
    startedAt,
    endedAt,
    lastActivityAt: events.at(-1)?.timestamp,
    toolCalls: tools.size,
    current
  }
}

export function formatSubAgentDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${seconds}s`
}

/** "12 tools · 3m 04s", leaving out whatever is not known. */
export function subAgentStats(toolCalls?: number, durationMs?: number): string {
  return [
    toolCalls !== undefined ? `${toolCalls} ${toolCalls === 1 ? 'tool' : 'tools'}` : '',
    durationMs !== undefined ? formatSubAgentDuration(durationMs) : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How a sub-agent ended, read from the delegating tool's result; undefined while it runs. */
export function subAgentOutcome(data: Record<string, unknown> | null): SubAgentOutcome | undefined {
  const state = typeof data?.status === 'string' ? TERMINAL_STATES[data.status] : undefined
  if (!data || !state) return undefined
  const report = typeof data.content === 'string' ? headline(data.content) : undefined
  const error = typeof data.error === 'string' && data.error ? clip(data.error, 160) : undefined
  return {
    state,
    headline: state === 'done' ? (report ?? error) : (error ?? report),
    toolCalls: typeof data.toolCalls === 'number' ? data.toolCalls : undefined,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined
  }
}
