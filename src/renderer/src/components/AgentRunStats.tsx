import { useEffect, useRef, useState } from 'react'
import { Brain, Coins, Hand, Layers, PenLine, Timer, Wrench, Zap } from 'lucide-react'
import type { ContentSegment, TokenUsage } from '../types/chat.types'
import { motionAllowed } from '../utils/messageMotion'

/** Characters per token, to count a turn the server has not reported usage for yet. */
const CHARACTERS_PER_TOKEN = 4

type RunActivity = 'waiting' | 'thinking' | 'tools' | 'writing' | 'you'

const ACTIVITY_LABELS: Record<RunActivity, string> = {
  waiting: 'Waiting for model',
  thinking: 'Thinking',
  tools: 'Using tools',
  writing: 'Writing',
  you: 'Waiting for you'
}

function runActivity(segments: readonly ContentSegment[] | undefined): RunActivity {
  const last = segments?.findLast((segment) => segment.type !== 'run_status')
  if (!last) return 'waiting'
  if (
    (last.type === 'interaction' && last.interaction?.status === 'pending') ||
    (last.type === 'decision' && last.decision?.status === 'pending')
  )
    return 'you'
  if (last.type === 'tool') return 'tools'
  if (last.type === 'thinking') return 'thinking'
  return 'writing'
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  return `${seconds}s`
}

function formatCount(value: number): string {
  if (value < 1_000) return Math.round(value).toString()
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`
  return `${Math.round(value / 1_000)}k`
}

/** Eases a displayed number toward its target, so counts roll up instead of jumping. */
function useRollingNumber(target: number): number {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  useEffect(() => {
    let frame = 0
    const step = (): void => {
      const gap = target - shownRef.current
      // Hidden or reduced motion, and the last pixel of the roll, land at once.
      shownRef.current =
        !motionAllowed() || Math.abs(gap) < 1 ? target : shownRef.current + gap * 0.18
      setShown(shownRef.current)
      if (shownRef.current !== target) frame = window.requestAnimationFrame(step)
    }
    frame = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frame)
  }, [target])
  return shown
}

/**
 * The live line at the foot of a working reply: what the agent is doing, for how long, how much
 * it has written and how fast, and how full its context is. Once the reply ends, the footer's
 * totals take its place.
 */
export function AgentRunStats({
  startedAt,
  usage,
  segments
}: {
  startedAt?: number
  usage?: TokenUsage
  segments?: readonly ContentSegment[]
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const activity = runActivity(segments)
  const streaming = usage?.streaming
  const streamedTokens = streaming ? streaming.characters / CHARACTERS_PER_TOKEN : 0
  const generated = useRollingNumber(
    (usage?.generatedTokens ?? usage?.completionTokens ?? 0) + streamedTokens
  )
  const streamSeconds = streaming ? (streaming.updatedAt - streaming.startedAt) / 1_000 : 0
  // The turn being written gives the speed it is going at; between turns, the run's average.
  const speed =
    streaming && streamSeconds >= 1 ? streamedTokens / streamSeconds : usage?.tokensPerSecond
  const flowing = Boolean(streaming && now - streaming.updatedAt < 2_000)
  const toolCount = segments?.filter((segment) => segment.type === 'tool').length ?? 0
  const context = usage?.promptTokens ?? 0

  return (
    <div className="agent-run-stats" role="status" aria-live="off" data-activity={activity}>
      <span key={activity} className="agent-run-stats-activity">
        <span className="agent-run-stats-dot" aria-hidden="true" />
        {activity === 'thinking' ? (
          <Brain size={13} aria-hidden="true" />
        ) : activity === 'tools' ? (
          <Wrench size={13} aria-hidden="true" />
        ) : activity === 'you' ? (
          <Hand size={13} aria-hidden="true" />
        ) : activity === 'writing' ? (
          <PenLine size={13} aria-hidden="true" />
        ) : null}
        <span className="agent-run-stats-label">{ACTIVITY_LABELS[activity]}</span>
      </span>
      {startedAt !== undefined && (
        <span className="agent-run-stats-item" title="Time since the message was sent">
          <Timer size={13} aria-hidden="true" />
          {formatElapsed(now - startedAt)}
        </span>
      )}
      {generated >= 1 && (
        <span className="agent-run-stats-item" title="Tokens the model has generated">
          <Coins size={13} aria-hidden="true" />
          {formatCount(generated)} tokens
        </span>
      )}
      {speed !== undefined && speed > 0 && (
        <span
          className={`agent-run-stats-item${flowing ? ' is-flowing' : ''}`}
          title="Generation speed"
        >
          <Zap size={13} aria-hidden="true" />
          {speed.toFixed(speed < 10 ? 1 : 0)} t/s
        </span>
      )}
      {toolCount > 0 && (
        <span className="agent-run-stats-item" title="Tool calls">
          <Wrench size={13} aria-hidden="true" />
          {toolCount}
        </span>
      )}
      {context > 0 && (
        <span className="agent-run-stats-item" title="Tokens in the model's context">
          <Layers size={13} aria-hidden="true" />
          {formatCount(context)} context
        </span>
      )}
    </div>
  )
}
