import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bot, Loader2, Square } from 'lucide-react'
import type { Message } from '../types/chat.types'
import { useSubAgentRun } from '../hooks/useSubAgentRun'
import { subAgentActivity, subAgentStats, type SubAgentState } from '../utils/subAgentActivity'
import { MessageItem } from './MessageItem'
import { MessageMarkdown } from './MessageMarkdown'
import { SubAgentStateIcon } from './SubAgentCard'
import type { SubAgentTarget } from './subAgentNavigation'

const STATE_LABELS: Record<SubAgentState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}

const noop = (): void => undefined
const NO_EXPANDED = new Set<string>()

async function resolveInteraction(
  interactionId: string,
  response: Record<string, unknown>,
  cancelled?: boolean
): Promise<void> {
  await window.api.agentRuns.resolveInteraction({ interactionId, response, cancelled })
}

/**
 * A sub-agent's own transcript, opened over the chat: the task it was given,
 * then everything it did, drawn like any reply. Esc or Back returns to the
 * chat where it was left.
 */
export function SubAgentView({
  target,
  workspaceFolder,
  onBack,
  onContextUpdate
}: {
  target: SubAgentTarget
  workspaceFolder?: string | null
  onBack: () => void
  /** The sub-agent's own context, for the meter while its view is open. */
  onContextUpdate?: (tokens: number) => void
}): React.JSX.Element {
  const [live, setLive] = useState(true)
  const { snapshot, error, loaded } = useSubAgentRun(target.runId, live)
  const activity = useMemo(() => subAgentActivity(snapshot.events, snapshot.projection), [snapshot])
  const working = activity.state === 'working' || activity.state === 'waiting'
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const backRef = useRef<HTMLButtonElement>(null)

  const contextTokens =
    snapshot.projection.tokenUsage.promptTokens + snapshot.projection.tokenUsage.completionTokens
  useEffect(() => {
    if (loaded) onContextUpdate?.(contextTokens)
  }, [contextTokens, loaded, onContextUpdate])

  // Stop listening once the run has ended; a finished run does not change.
  useEffect(() => {
    if (loaded && !working) setLive(false)
  }, [loaded, working])

  useEffect(() => {
    if (!working) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  useEffect(() => {
    backRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  // Stay at the newest step while the reader is there, as a live log would.
  useEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [snapshot])

  const message: Message = useMemo(
    () => ({
      id: `subagent:${target.runId}`,
      role: 'agent',
      content: snapshot.projection.content,
      thinking: snapshot.projection.thinking,
      segments: snapshot.projection.segments as Message['segments'],
      tokenUsage: snapshot.projection.tokenUsage,
      timestamp: activity.startedAt ?? Date.now(),
      runId: target.runId
    }),
    [activity.startedAt, snapshot, target.runId]
  )

  const elapsed =
    activity.startedAt !== undefined
      ? (activity.endedAt ?? (working ? now : (activity.lastActivityAt ?? now))) -
        activity.startedAt
      : undefined
  const brief = [target.task, target.context && `**Context**\n\n${target.context}`]
    .filter(Boolean)
    .join('\n\n')

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await window.api.agentRuns.stop(target.runId)
    } finally {
      setStopping(false)
    }
  }

  return (
    <section className="subagent-view" aria-label={`Sub-agent: ${target.title}`}>
      <header className="subagent-view__header">
        <button
          ref={backRef}
          type="button"
          className="subagent-view__back"
          onClick={onBack}
          title="Back to the chat (Esc)"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Chat
        </button>
        <span className="subagent-view__separator" aria-hidden="true">
          /
        </span>
        <Bot size={14} className="subagent-view__bot" aria-hidden="true" />
        <h2 className="subagent-view__title" title={target.title}>
          {target.title}
        </h2>
        {loaded && (
          <span className={`subagent-view__status is-${activity.state}`}>
            <SubAgentStateIcon state={activity.state} />
            {STATE_LABELS[activity.state]}
            {subAgentStats(activity.toolCalls, elapsed) && (
              <span className="subagent-view__stats">
                {subAgentStats(activity.toolCalls, elapsed)}
              </span>
            )}
          </span>
        )}
        {working && loaded && (
          <button
            type="button"
            className="subagent-view__stop"
            onClick={() => void stop()}
            disabled={stopping}
            title="Stop this sub-agent; the chat continues with what it found"
          >
            <Square size={10} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        )}
      </header>

      <div
        className="messages-container subagent-view__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
        {brief && (
          <div className="subagent-view__brief">
            <div className="subagent-view__brief-label">Task from the agent</div>
            <MessageMarkdown content={brief} workspaceRoot={workspaceFolder ?? undefined} />
          </div>
        )}
        {error ? (
          <div className="subagent-view__error">{error}</div>
        ) : !loaded ? (
          <div className="subagent-view__loading">
            <Loader2 size={14} className="icon-spin" aria-hidden="true" /> Loading the sub-agent…
          </div>
        ) : (
          <MessageItem
            message={message}
            index={0}
            isLoading={working}
            expandedThinking={NO_EXPANDED}
            editingMessageId={null}
            editingGeometry={null}
            editingContent=""
            copiedMessageId={null}
            onToggleThinking={noop}
            onHandleArtifactResult={noop}
            onEditMessage={noop}
            onCancelEditMessage={noop}
            onConfirmEditMessage={noop}
            onCopyMessage={noop}
            onRetryMessage={noop}
            onSetEditingContent={noop}
            onApproveToolLimitDecision={(id) => void resolveInteraction(id, { approved: true })}
            onDenyToolLimitDecision={(id) => void resolveInteraction(id, { approved: false })}
            onResolveAgentInteraction={resolveInteraction}
            workspaceFolder={workspaceFolder}
            readOnly
          />
        )}
      </div>
    </section>
  )
}
