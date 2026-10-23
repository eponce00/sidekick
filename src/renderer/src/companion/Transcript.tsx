import { AlertTriangle, Check, CircleSlash, Loader2, X } from 'lucide-react'
import type { CompanionMessage } from '../../../shared/companion'
import {
  savedSegments,
  toolDetail,
  type PendingSend,
  type Segment,
  type ToolSegment
} from './chatState'
import { InteractionCard, type ResolveInteraction } from './InteractionCard'
import { Markdown } from './Markdown'

function ToolStatusIcon({ status }: { status: ToolSegment['tool']['status'] }) {
  if (status === 'pending' || status === 'running')
    return <Loader2 size={16} className="icon-spin" aria-label="Running" />
  if (status === 'success') return <Check size={16} className="is-success" aria-label="Done" />
  if (status === 'denied') return <CircleSlash size={16} className="is-muted" aria-label="Denied" />
  if (status === 'partial')
    return <AlertTriangle size={16} className="is-warning" aria-label="Partly done" />
  return <X size={16} className="is-error" aria-label="Failed" />
}

function ToolRow({ tool }: { tool: ToolSegment['tool'] }) {
  const detail = toolDetail(tool)
  const title = tool.title || tool.name || 'Tool'
  return (
    <details className={`cp-tool is-${tool.status}`}>
      <summary>
        <ToolStatusIcon status={tool.status} />
        <span className="cp-tool-title">{title}</span>
      </summary>
      <div className="cp-tool-detail">
        <p>{title}</p>
        {detail && <pre>{detail}</pre>}
      </div>
    </details>
  )
}

const RETRY_LABELS: Record<string, string> = {
  run_continued: 'Continued',
  provider_retry: 'Retrying',
  workspace_verification_required: 'Checking the work'
}

function SegmentView({
  segment,
  streaming,
  answered,
  onResolve
}: {
  segment: Segment
  streaming: boolean
  answered: ReadonlySet<string>
  onResolve?: ResolveInteraction
}) {
  switch (segment.type) {
    case 'text':
      return segment.content.trim() ? <Markdown text={segment.content} /> : null
    case 'thinking':
      return segment.content.trim() ? (
        <details className="cp-thinking">
          <summary>{streaming ? 'Thinking…' : 'Thinking'}</summary>
          <p>{segment.content}</p>
        </details>
      ) : null
    case 'tool':
      return <ToolRow tool={segment.tool} />
    case 'interaction':
      return (
        <InteractionCard
          interaction={segment.interaction}
          answered={answered.has(segment.interaction.id)}
          onResolve={onResolve ?? (() => undefined)}
        />
      )
    case 'decision':
      return segment.decision.status === 'pending' ? (
        <section className="cp-card is-pending">
          <p className="cp-card-copy">{segment.decision.prompt}</p>
          <p className="cp-card-copy">Answer this on the computer.</p>
        </section>
      ) : null
    case 'run_error':
      return (
        <p className="cp-run-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{segment.runError.message}</span>
        </p>
      )
    case 'run_status':
      return (
        <p className="cp-notice">
          {RETRY_LABELS[segment.status.reason] ?? 'Retrying'}
          {segment.status.detail ? `: ${segment.status.detail}` : ''}
        </p>
      )
    case 'summary':
      return <p className="cp-notice">Earlier messages were summarized to save space.</p>
    case 'artifact':
      return <p className="cp-notice">{segment.artifact.title}: open it on the computer.</p>
    case 'verification':
      return (
        <>
          {segment.steps?.map((step, index) => (
            <SegmentView key={index} segment={step} streaming={false} answered={answered} />
          ))}
          {segment.content && <Markdown text={segment.content} />}
        </>
      )
    default:
      return null
  }
}

function Segments({
  segments,
  streaming,
  answered,
  onResolve
}: {
  segments: readonly Segment[]
  streaming: boolean
  answered: ReadonlySet<string>
  onResolve?: ResolveInteraction
}) {
  // A message sent while the run worked splits its reply: the reply so far, the message, the rest.
  const groups: Array<{ steer: Extract<Segment, { type: 'steer' }> } | { items: number[] }> = []
  segments.forEach((segment, index) => {
    if (segment.type === 'steer') groups.push({ steer: segment })
    else {
      const last = groups.at(-1)
      if (last && 'items' in last) last.items.push(index)
      else groups.push({ items: [index] })
    }
  })
  return (
    <>
      {groups.map((group, groupIndex) =>
        'steer' in group ? (
          <div key={group.steer.steer.id} className="cp-row is-user">
            <div className="cp-bubble">{group.steer.steer.content}</div>
          </div>
        ) : (
          <div key={groupIndex} className="cp-row is-assistant">
            {group.items.map((index) => (
              <SegmentView
                key={index}
                segment={segments[index]}
                streaming={streaming && index === segments.length - 1}
                answered={answered}
                onResolve={onResolve}
              />
            ))}
          </div>
        )
      )}
    </>
  )
}

const NONE: ReadonlySet<string> = new Set()

function MessageView({ message }: { message: CompanionMessage }) {
  if (message.role === 'user') {
    return (
      <div className="cp-row is-user">
        <div className="cp-bubble">
          {message.content}
          {Boolean(message.imageCount) && (
            <span className="cp-bubble-note">
              {message.imageCount === 1 ? '1 image' : `${message.imageCount} images`}
            </span>
          )}
        </div>
      </div>
    )
  }
  if (message.role === 'assistant') {
    const segments = savedSegments(message.segments)
    return segments.length ? (
      <Segments segments={segments} streaming={false} answered={NONE} />
    ) : (
      <div className="cp-row is-assistant">
        <Markdown text={message.content} />
      </div>
    )
  }
  return message.content.trim() ? <p className="cp-notice">{message.content}</p> : null
}

export function Transcript({
  messages,
  liveSegments,
  runActive,
  phase,
  unconfirmed,
  answered,
  onResolve
}: {
  messages: readonly CompanionMessage[]
  liveSegments: readonly Segment[]
  runActive: boolean
  phase: string | null
  unconfirmed: readonly PendingSend[]
  answered: ReadonlySet<string>
  onResolve: ResolveInteraction
}) {
  const waiting = phase === 'awaiting_permission' || phase === 'awaiting_user'
  return (
    <div className="cp-transcript">
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
      <Segments
        segments={liveSegments}
        streaming={runActive}
        answered={answered}
        onResolve={onResolve}
      />
      {runActive && !waiting && (
        <p className="cp-working" role="status">
          <Loader2 size={16} className="icon-spin" aria-hidden="true" />
          Working…
        </p>
      )}
      {unconfirmed.map((send) => (
        <div key={send.id} className="cp-row is-user is-unconfirmed">
          <div className="cp-bubble">{send.text}</div>
        </div>
      ))}
    </div>
  )
}
