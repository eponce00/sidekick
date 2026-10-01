import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, ChevronRight, CircleAlert, Clock, Loader2, Square, X } from 'lucide-react'
import type { ToolExecution } from '../types/chat.types'
import { useSubAgentRun } from '../hooks/useSubAgentRun'
import {
  SUB_AGENT_QUIET_MS,
  subAgentActivity,
  subAgentOutcome,
  subAgentStats,
  type SubAgentState
} from '../utils/subAgentActivity'
import AgentInteractionCard from './AgentInteractionCard'
import {
  isArtifactBuild,
  subAgentTarget,
  subAgentTitle,
  useOpenSubAgent
} from './subAgentNavigation'

export function SubAgentStateIcon({ state }: { state: SubAgentState }): React.JSX.Element {
  if (state === 'working') return <Loader2 size={14} className="icon-spin" aria-hidden="true" />
  if (state === 'waiting') return <CircleAlert size={14} aria-hidden="true" />
  if (state === 'done') return <Check size={14} aria-hidden="true" />
  if (state === 'failed') return <X size={14} aria-hidden="true" />
  return <Square size={11} aria-hidden="true" />
}

async function resolveInteraction(
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
): Promise<void> {
  await window.api.agentRuns.resolveInteraction({ interactionId, response, cancelled })
}

/**
 * A delegated task in the chat: one row naming the task, with what the
 * sub-agent is doing now while it works and the start of its report once it
 * is done. The row opens the sub-agent's full transcript in its own view.
 * Anything the sub-agent needs from the user is answered under the row.
 */
export function SubAgentCard({ tool }: { tool: ToolExecution }): React.JSX.Element {
  const data =
    tool.data && typeof tool.data === 'object' ? (tool.data as Record<string, unknown>) : null
  const childRunId = typeof data?.childRunId === 'string' ? data.childRunId : null
  const isRunning = tool.status === 'running' || tool.status === 'pending'
  const builder = isArtifactBuild(tool)
  const openSubAgent = useOpenSubAgent()
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(Date.now)

  // Only a working sub-agent is followed; a finished one is read from its result.
  const { snapshot } = useSubAgentRun(isRunning ? childRunId : null, isRunning)
  const activity = useMemo(() => subAgentActivity(snapshot.events, snapshot.projection), [snapshot])
  const outcome = subAgentOutcome(data)
  // Tasks delegated together are recorded as finished only when the last of
  // them is, so a sub-agent can be done while its call still reads as running.
  // Its own run says when it has ended; the row follows that.
  const childEnded =
    isRunning &&
    Boolean(childRunId) &&
    snapshot.events.length > 0 &&
    (activity.state === 'done' || activity.state === 'failed' || activity.state === 'stopped')
  const live = isRunning && Boolean(childRunId) && !childEnded

  const pending = live
    ? snapshot.projection.segments.flatMap((segment) =>
        segment.type === 'interaction' && segment.interaction.status === 'pending'
          ? [segment.interaction]
          : []
      )
    : []
  // Runs from before sub-agents stopped asking can still hold a tool-limit question.
  const decisions = live
    ? snapshot.projection.segments.flatMap((segment) =>
        segment.type === 'decision' && segment.decision.status === 'pending'
          ? [segment.decision]
          : []
      )
    : []

  useEffect(() => {
    if (!live) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const state: SubAgentState =
    outcome?.state ??
    (childEnded
      ? activity.state
      : isRunning
        ? live && snapshot.events.length
          ? activity.state === 'waiting'
            ? 'waiting'
            : 'working'
          : 'working'
        : tool.status === 'success'
          ? 'done'
          : /cancel/i.test(tool.error ?? '')
            ? 'stopped'
            : 'failed')
  const quietFor =
    state === 'working' && activity.lastActivityAt ? now - activity.lastActivityAt : 0

  // Waiting for another sub-agent on the same provider to finish before it starts.
  const queued = isRunning && !childRunId && data?.queued === true

  let detail: React.ReactNode
  let stats = ''
  // A build counts versions of the artifact rather than tools; the agent's own is the first.
  const builds = snapshot.projection.segments.filter(
    (segment) => segment.type === 'tool' && segment.tool.name === 'create_artifact'
  )
  const version = builds.length + 1
  const rendering = builds.some(
    (segment) =>
      segment.type === 'tool' &&
      (segment.tool.status === 'running' || segment.tool.status === 'pending')
  )

  if (queued) {
    detail = 'Queued until another sub-agent finishes'
  } else if (childEnded) {
    detail =
      (builder ? undefined : activity.report) ??
      (state === 'stopped'
        ? 'Stopped before it reported'
        : state === 'failed'
          ? 'Failed'
          : builder
            ? 'Checking the final version'
            : 'Finished')
    stats = subAgentStats(
      builder ? undefined : activity.toolCalls,
      activity.startedAt !== undefined && activity.endedAt !== undefined
        ? activity.endedAt - activity.startedAt
        : undefined
    )
  } else if (isRunning && builder) {
    detail =
      state === 'waiting'
        ? 'Needs your answer below'
        : rendering
          ? `Rendering version ${version}`
          : `Reviewing version ${version}`
    stats = [
      `${version} ${version === 1 ? 'version' : 'versions'}`,
      activity.startedAt !== undefined ? subAgentStats(undefined, now - activity.startedAt) : ''
    ]
      .filter(Boolean)
      .join(' · ')
  } else if (isRunning) {
    detail =
      state === 'waiting' ? (
        'Needs your answer below'
      ) : quietFor >= SUB_AGENT_QUIET_MS ? (
        <>
          {activity.current ?? 'Working'}
          <span className="sa-card__quiet">
            {' '}
            · No activity for {Math.floor(quietFor / 60_000)} min
          </span>
        </>
      ) : (
        (activity.current ?? 'Starting')
      )
    stats = subAgentStats(
      activity.toolCalls,
      activity.startedAt !== undefined ? now - activity.startedAt : undefined
    )
  } else {
    detail =
      outcome?.headline ??
      (state === 'stopped'
        ? 'Stopped before it reported'
        : state === 'failed'
          ? tool.error || 'Failed'
          : 'Finished')
    stats = subAgentStats(outcome?.toolCalls, outcome?.durationMs)
  }

  const title = subAgentTitle(tool)
  const openLabel = builder
    ? 'See each version the builder made'
    : 'Open the sub-agent’s transcript'
  const open =
    childRunId && openSubAgent ? () => openSubAgent(subAgentTarget(tool, childRunId)) : undefined

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
    <div className={`sa-card is-${state}${queued ? ' is-queued' : ''}`}>
      <div className="sa-card__row">
        <button
          type="button"
          className="sa-card__main"
          onClick={open}
          disabled={!open}
          title={open ? openLabel : undefined}
        >
          <span className="sa-card__icon">
            <Bot size={15} aria-hidden="true" />
            <span className="sa-card__badge">
              {queued ? (
                <Clock size={14} aria-hidden="true" />
              ) : (
                <SubAgentStateIcon state={state} />
              )}
            </span>
          </span>
          <span className="sa-card__text">
            <span className="sa-card__title">{title}</span>
            <span className="sa-card__detail" role={live ? 'status' : undefined}>
              {detail}
            </span>
          </span>
          {stats && <span className="sa-card__stats">{stats}</span>}
          {open && <ChevronRight size={14} className="sa-card__open" aria-hidden="true" />}
        </button>
        {live && (
          <button
            type="button"
            className="sa-card__stop"
            onClick={() => void stop()}
            disabled={stopping}
            title="Stop this sub-agent; the chat continues with what it found"
            aria-label="Stop sub-agent"
          >
            <Square size={10} fill="currentColor" aria-hidden="true" />
          </button>
        )}
      </div>

      {pending.map((interaction) => (
        <div key={interaction.id} className="sa-card__request">
          <AgentInteractionCard interaction={interaction} onResolve={resolveInteraction} />
        </div>
      ))}
      {decisions.map((decision) => (
        <div key={decision.id} className="sa-card__request sa-card__decision">
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
    </div>
  )
}
