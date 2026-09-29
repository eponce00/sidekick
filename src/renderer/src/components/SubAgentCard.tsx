import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  GitBranch,
  Globe,
  Loader2,
  MessageSquare,
  Search,
  Square,
  Terminal,
  X
} from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import type { SubAgentStep } from '../types/subagent.types'
import { useSubAgentRun } from '../hooks/useSubAgentRun'
import {
  SUB_AGENT_QUIET_MS,
  subAgentActivity,
  subAgentResultSummary,
  subAgentSteps,
  type SubAgentState
} from '../utils/subAgentActivity'
import AgentInteractionCard from './AgentInteractionCard'
import ToolCallRow from './ToolCallRow'

// A long sub-agent has thousands of steps; the newest are shown, the rest on request.
const STEPS_SHOWN = 40

const STATE_LABELS: Record<SubAgentState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${seconds}s`
}

async function resolveInteraction(
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
): Promise<void> {
  await window.api.agentRuns.resolveInteraction({ interactionId, response, cancelled })
}

function SubAgentSteps({ steps }: { steps: SubAgentStep[] }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showAll, setShowAll] = useState(false)
  const hidden = showAll ? 0 : Math.max(0, steps.length - STEPS_SHOWN)

  // Follow the newest step, as a live log would.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [steps.length])

  return (
    <div className="sa-steps" ref={scrollRef}>
      {hidden > 0 && (
        <button type="button" className="sa-steps__earlier" onClick={() => setShowAll(true)}>
          Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
        </button>
      )}
      {steps.slice(hidden).map((step, index) => (
        <div key={hidden + index} className={`sa-step sa-step--${step.type}`}>
          <span className={`sa-step__icon ${step.status ? `sa-step__icon--${step.status}` : ''}`}>
            {step.type === 'tool_call' ? (
              step.name === 'web_search' ? (
                <Search size={11} />
              ) : step.name === 'web_fetch' ? (
                <Globe size={11} />
              ) : step.name === 'shell' ? (
                <Terminal size={11} />
              ) : (
                <Loader2 size={11} />
              )
            ) : step.type === 'tool_result' ? (
              step.status === 'error' ? (
                <X size={11} />
              ) : (
                <Check size={11} />
              )
            ) : step.type === 'response' ? (
              <MessageSquare size={11} />
            ) : null}
          </span>
          <span className="sa-step__body">{step.content}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * A delegated task in the chat. While the sub-agent works, the card follows its
 * own run live: what it is doing, for how long, how many tools it has used, and
 * whether it has gone quiet. Anything it needs from the user is answered here,
 * and it can be stopped on its own; the chat then carries on with what it had.
 */
export function SubAgentCard({ tool }: { tool: ToolExecution }): React.JSX.Element {
  const data =
    tool.data && typeof tool.data === 'object' ? (tool.data as Record<string, unknown>) : null
  const childRunId = typeof data?.childRunId === 'string' ? data.childRunId : null
  const isRunning = tool.status === 'running' || tool.status === 'pending'
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(Date.now)

  // Follow live while running; a finished one loads only when opened.
  const follow = Boolean(childRunId) && (isRunning || expanded)
  const { snapshot, error } = useSubAgentRun(follow ? childRunId : null, isRunning)
  const activity = useMemo(() => subAgentActivity(snapshot.events, snapshot.projection), [snapshot])
  const steps = useMemo(() => subAgentSteps(snapshot.projection), [snapshot])
  const pending = snapshot.projection.segments.flatMap((segment) =>
    segment.type === 'interaction' && segment.interaction.status === 'pending'
      ? [segment.interaction]
      : []
  )
  // Runs from before sub-agents stopped asking can still hold a tool-limit question.
  const decisions = snapshot.projection.segments.flatMap((segment) =>
    segment.type === 'decision' && segment.decision.status === 'pending' ? [segment.decision] : []
  )
  const live = isRunning && Boolean(childRunId) && snapshot.events.length > 0
  // The finished result, read as a sentence rather than the raw tool data.
  const resultSummary =
    subAgentResultSummary(data) ??
    (tool.status === 'error' || tool.status === 'denied'
      ? /cancel/i.test(tool.error ?? '')
        ? 'Stopped'
        : `Failed${tool.error ? ` — ${tool.error}` : ''}`
      : undefined)
  // The card keeps the name it had while working, whatever the tool result is titled.
  const row = useMemo(() => ({ ...tool, title: 'Delegate task' }), [tool])
  const embeddedSteps = tool.subAgentSteps?.length ? tool.subAgentSteps : null
  const displayedSteps = embeddedSteps ?? steps

  useEffect(() => {
    if (!live) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const quietFor =
    live && activity.state === 'working' && activity.lastActivityAt
      ? now - activity.lastActivityAt
      : 0
  const elapsed =
    activity.startedAt !== undefined
      ? (activity.endedAt ?? (live ? now : (activity.lastActivityAt ?? now))) - activity.startedAt
      : undefined

  const stop = async (): Promise<void> => {
    if (!childRunId) return
    setStopping(true)
    try {
      await window.api.agentRuns.stop(childRunId)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className={`sa-inline sa-inline-${tool.status}`}>
      <ToolCallRow
        tool={row}
        onSelect={() => setExpanded(!expanded)}
        expandable
        expanded={expanded}
      />

      {live && (
        <div className={`sa-inline__status is-${activity.state}`} role="status">
          <span className="sa-inline__dot" aria-hidden="true" />
          <span className="sa-inline__state">{STATE_LABELS[activity.state]}</span>
          {elapsed !== undefined && <span>{formatElapsed(elapsed)}</span>}
          <span>
            {activity.toolCalls} {activity.toolCalls === 1 ? 'tool' : 'tools'}
          </span>
          {activity.current && activity.state === 'working' && (
            <span className="sa-inline__current" title={activity.current}>
              {activity.current}
            </span>
          )}
          {quietFor >= SUB_AGENT_QUIET_MS && (
            <span className="sa-inline__quiet">
              No activity for {Math.floor(quietFor / 60_000)} min
            </span>
          )}
          <button
            type="button"
            className="sa-inline__stop"
            onClick={() => void stop()}
            disabled={stopping}
            title="Stop this sub-agent; the chat continues with what it found"
          >
            <Square size={9} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        </div>
      )}

      {/* What the sub-agent needs from the user stays in sight, even collapsed. */}
      {pending.map((interaction) => (
        <div key={interaction.id} className="sa-inline__interaction">
          <AgentInteractionCard interaction={interaction} onResolve={resolveInteraction} />
        </div>
      ))}
      {decisions.map((decision) => (
        <div key={decision.id} className="sa-inline__decision">
          <span>The sub-agent reached its tool limit after {decision.roundsUsed} rounds.</span>
          <button
            type="button"
            onClick={() => void resolveInteraction(decision.id, { approved: true })}
          >
            Let it continue
          </button>
          <button
            type="button"
            onClick={() => void resolveInteraction(decision.id, { approved: false })}
          >
            Stop it
          </button>
        </div>
      ))}

      {!expanded && !live && (resultSummary || tool.output) && (
        <div className="sa-inline__summary">{resultSummary || tool.output}</div>
      )}

      {expanded && (
        <div className="sa-inline__body">
          {displayedSteps.length ? (
            <SubAgentSteps steps={displayedSteps} />
          ) : isRunning || (follow && !error) ? (
            <div className="sa-inline__waiting">
              <Loader2 size={12} className="icon-spin" />
              <span>{isRunning ? 'Starting…' : 'Loading the sub-agent…'}</span>
            </div>
          ) : null}
          {childRunId && (
            <div className="sa-inline__lineage">
              <GitBranch size={11} /> Sub-agent run <code>{childRunId.slice(0, 8)}</code>
            </div>
          )}
          {error && <div className="sa-inline__error">{error}</div>}
          {tool.error && <div className="sa-inline__error">{tool.error}</div>}
        </div>
      )}
    </div>
  )
}
