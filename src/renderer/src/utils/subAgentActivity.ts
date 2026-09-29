import type { ProjectedAgentRunMessage } from '../../../shared/agentEventProjection'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { SubAgentStep } from '../types/subagent.types'

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

// A sub-agent this quiet has usually stalled, rather than being in a long step.
export const SUB_AGENT_QUIET_MS = 3 * 60_000

const TERMINAL_STATES: Record<string, SubAgentState> = {
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'stopped'
}

function clip(text: string, length = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat
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
  const state = TERMINAL_STATES[phase] ?? (waiting ? 'waiting' : 'working')

  let current: string | undefined
  if (state === 'waiting') current = 'Waiting on you'
  else if (state === 'working') {
    // Between tools the model is reasoning; the last finished tool is not what it is doing.
    const runningTool = projection.segments.some(
      (segment) =>
        segment.type === 'tool' &&
        (segment.tool.status === 'running' || segment.tool.status === 'pending')
    )
    if (phase === 'streaming' && !runningTool) {
      const last = projection.segments.at(-1)
      current = last?.type === 'text' && last.content.trim() ? 'Writing its reply' : 'Thinking'
    }
    for (let index = projection.segments.length - 1; index >= 0 && !current; index--) {
      const segment = projection.segments[index]
      if (segment.type === 'tool') {
        current =
          segment.tool.status === 'running' || segment.tool.status === 'pending'
            ? clip(segment.tool.title)
            : `Done: ${clip(segment.tool.title, 70)}`
      } else if (segment.type === 'thinking') current = 'Thinking'
      else if (segment.type === 'text' && segment.content.trim()) current = 'Writing its reply'
    }
    current ??= 'Starting'
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

const RESULT_LABELS: Record<string, string> = {
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Stopped'
}

/**
 * A finished sub-agent's result as one line: how it ended, then the start of
 * what it reported. Undefined when the tool data is not a sub-agent result.
 */
export function subAgentResultSummary(data: Record<string, unknown> | null): string | undefined {
  if (!data || typeof data.status !== 'string' || !RESULT_LABELS[data.status]) return undefined
  const report = typeof data.content === 'string' ? clip(data.content, 160) : ''
  const error = typeof data.error === 'string' ? clip(data.error, 160) : ''
  const detail = report || error
  return detail ? `${RESULT_LABELS[data.status]} — ${detail}` : RESULT_LABELS[data.status]
}

/** The sub-agent's steps for its transcript: thoughts, tools and results, and what it wrote. */
export function subAgentSteps(projection: ProjectedAgentRunMessage): SubAgentStep[] {
  const steps = (segment: ProjectedAgentRunMessage['segments'][number]): SubAgentStep[] => {
    if (segment.type === 'verification') {
      const folded = (segment.steps ?? []).flatMap(steps)
      return segment.content ? [...folded, { type: 'response', content: segment.content }] : folded
    }
    if (segment.type === 'thinking') return [{ type: 'thinking', content: segment.content }]
    if (segment.type === 'text') return [{ type: 'response', content: segment.content }]
    if (segment.type === 'tool') {
      return [
        {
          type:
            segment.tool.status === 'running' || segment.tool.status === 'pending'
              ? 'tool_call'
              : 'tool_result',
          name: segment.tool.name,
          content: segment.tool.output || segment.tool.error || segment.tool.title,
          status:
            segment.tool.status === 'error' || segment.tool.status === 'denied'
              ? 'error'
              : segment.tool.status === 'success' || segment.tool.status === 'partial'
                ? 'success'
                : 'running'
        }
      ]
    }
    return []
  }
  return projection.segments.flatMap(steps)
}
