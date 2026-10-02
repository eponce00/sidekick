import { Children, useState, useRef, useEffect, useLayoutEffect, memo } from 'react'
import {
  Loader2,
  Check,
  X,
  AlignLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  RotateCcw,
  Info,
  CircleAlert,
  CircleCheck,
  ListChecks,
  Microscope,
  GitBranch,
  FileText,
  FolderOpen,
  MessageSquareText,
  CornerDownRight,
  Play
} from 'lucide-react'
import { formatTimestamp } from '../utils/messageFormatting'
import {
  chunkGroupsChronologically,
  finalAnswerText,
  groupSegments,
  isWorkSegmentGroup
} from '../utils/segmentGrouping'
import Artifact from './artifacts/Artifact'
import ToolCallRow from './ToolCallRow'
import { ToolExecutionCard } from './ToolExecutionCard'
import { TurnChangeReview } from './TurnChangeReview'
import AgentInteractionCard from './AgentInteractionCard'
import { resolveToolView } from '../services/uiContributions'
import { MessageMarkdown } from './MessageMarkdown'
import { MessageSources } from './MessageSources'
import { ImageAttachmentPreview } from './ImageAttachmentPreview'
import { ReadAloudButton } from './ReadAloudButton'
import { PastedTextAttachmentCard } from './PastedTextAttachment'
import {
  isPastedTextAttachment,
  isProjectContextAttachment,
  isReviewCommentAttachment,
  reviewCommentLineLabel
} from '../../../shared/messageContextAttachments'
import type { Message, MessageEditGeometry } from '../types/chat.types'
import type { GroupedSegment } from '../types/chat.types'
import {
  VERIFICATION_STATUS_COPY,
  type WorkspaceVerificationSummary
} from '../../../shared/verification'
import { MessageFooterPopover } from './MessageFooterPopover'
import { SubAgentCard } from './SubAgentCard'

const RETRY_LABELS: Record<string, string> = {
  provider_transcript_repaired: 'Repaired the provider transcript and retried',
  context_window_exceeded: 'Context limit reached; compacting and retrying',
  image_limit_exceeded: 'Too many images for this model; dropping older ones and retrying',
  truncated_tool_batch: 'Tool call stream was incomplete; retrying',
  research_source_required: 'Source verification required; continuing research',
  workspace_verification_required: 'Workspace changed; running a fresh verification',
  goal_continuation: 'Continuing the active goal',
  run_continued: 'Continuing the interrupted reply',
  provider_retry: 'Provider request failed; retrying'
}

function retryLabel(reason: string): string {
  if (reason.startsWith('tool_guard_')) return 'Tool loop detected; adjusting the next attempt'
  return RETRY_LABELS[reason] ?? reason.replaceAll('_', ' ')
}

function RunStatusSegment({
  status
}: {
  status: NonNullable<import('../types/chat.types').ContentSegment['status']>
}): React.JSX.Element {
  return (
    <div className="run-status-segment" role="status" title={status.detail}>
      <RotateCcw size={11} aria-hidden="true" />
      <span>{retryLabel(status.reason)}</span>
    </div>
  )
}

function RunErrorSegment({
  error,
  onRetry,
  onContinue
}: {
  error: NonNullable<import('../types/chat.types').ContentSegment['runError']>
  onRetry: () => void
  /** Offered only on an interrupted reply that is still the end of its conversation. */
  onContinue?: () => void | Promise<void>
}): React.JSX.Element {
  const [continuing, setContinuing] = useState(false)
  const interrupted = error.code === 'interrupted'
  if (interrupted && onContinue) {
    return (
      <div className="run-error-segment run-error-segment-interrupted" role="status">
        <CircleAlert size={15} aria-hidden="true" />
        <div>
          <strong>Interrupted</strong>
          <span>
            {error.message} Continue picks up from the saved progress and checks anything that was
            cut off mid-step before repeating it.
          </span>
        </div>
        <button
          type="button"
          className="run-error-continue"
          disabled={continuing}
          onClick={() => {
            // One interruption, one continuation: the button stays off after a click.
            setContinuing(true)
            void Promise.resolve(onContinue()).catch(() => setContinuing(false))
          }}
        >
          {continuing ? <Loader2 size={11} className="icon-spin" /> : <Play size={11} />} Continue
        </button>
      </div>
    )
  }
  return (
    <div className="run-error-segment" role={interrupted ? 'status' : 'alert'}>
      <CircleAlert size={15} aria-hidden="true" />
      <div>
        <strong>
          {interrupted
            ? 'Interrupted'
            : error.code
              ? error.code.replaceAll('_', ' ')
              : 'Run failed'}
        </strong>
        <span>{error.message}</span>
      </div>
      {error.retryable && (
        <button type="button" onClick={onRetry}>
          <RotateCcw size={11} /> Retry
        </button>
      )}
    </div>
  )
}

/** A message the user sent while the agent worked, shown where the run took it in. */
function SteerSegment({
  steer
}: {
  steer: NonNullable<import('../types/chat.types').ContentSegment['steer']>
}): React.JSX.Element {
  return (
    <div className="steer-segment" role="group" aria-label="Your message, sent while working">
      <div className="steer-segment-label">
        <CornerDownRight size={11} aria-hidden="true" />
        <span>You, while it worked</span>
      </div>
      {steer.content && <div className="steer-segment-content">{steer.content}</div>}
      {Boolean(steer.images?.length) && (
        <div className="message-image-attachments" aria-label="Attached images">
          {steer.images!.map((image) => (
            <ImageAttachmentPreview
              key={image.id}
              image={image}
              className="message-image-preview"
            />
          ))}
        </div>
      )}
      {Boolean(steer.attachments?.length) && (
        <div className="steer-segment-attachments">
          {steer.attachments!.map((attachment) => (
            <span key={attachment.id}>
              <FileText size={11} aria-hidden="true" />
              {attachment.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function CompactionSummarySegment({
  summary,
  modelContext
}: {
  summary: NonNullable<import('../types/chat.types').ContentSegment['summary']>
  modelContext?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const savedPercent = Math.round(
    Math.max(0, Math.min(1, 1 - summary.newTokens / Math.max(summary.originalTokens, 1))) * 100
  )
  // An assumed window is the usual reason a compaction fires far earlier than
  // expected; say so on the card instead of leaving it to look random.
  const assumedWindow = summary.contextReliable === false
  const windowLabel = summary.contextLength
    ? `${Math.round(summary.contextLength / 1_000)}k window`
    : null

  const copyContext = async (): Promise<void> => {
    if (!modelContext) return
    const result = await window.api.clipboard.writeText(modelContext)
    if (!result?.success) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <details className="summary-segment-compact">
      <summary>
        <AlignLeft className="summary-icon" size={12} aria-hidden="true" />
        <span className="summary-text">
          Context compacted · {summary.messagesCompacted.toLocaleString()} messages · {savedPercent}
          % saved
          {windowLabel && (
            <span
              className={`summary-window${assumedWindow ? ' is-assumed' : ''}`}
              title={
                assumedWindow
                  ? 'The provider did not report a context length, so SideKick assumed this one. Set the real value in Settings → Providers → Model details.'
                  : undefined
              }
            >
              {' '}
              · {assumedWindow ? `assumed ${windowLabel}` : windowLabel}
            </span>
          )}
        </span>
        <ChevronDown className="summary-arrow" size={12} aria-hidden="true" />
      </summary>
      <div className="summary-inspector">
        {modelContext ? (
          <>
            <div className="summary-inspector-header">
              <div>
                <strong>Context sent to the model</strong>
                <span>Inserted as a user message on the next request</span>
              </div>
              <button
                type="button"
                className="summary-copy-button"
                onClick={() => void copyContext()}
                aria-label={copied ? 'Copied compacted context' : 'Copy compacted context'}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="summary-content">{modelContext}</pre>
            <div className="summary-token-counts">
              {summary.originalTokens.toLocaleString()} → {summary.newTokens.toLocaleString()}{' '}
              estimated tokens
            </div>
          </>
        ) : (
          <p className="summary-unavailable">
            The compacted payload was not recorded for this older event.
          </p>
        )}
      </div>
    </details>
  )
}

const VERIFICATION_LABELS: Record<WorkspaceVerificationSummary['status'], string> = {
  passed: 'Checks passed',
  failed: 'Checks failed',
  stale: 'Checks out of date',
  unverified: 'Not checked',
  not_applicable: 'No checks needed'
}

/** The checks behind a verification result: the work of the pass and the evidence it left. */
function VerificationDetail({
  verification,
  note,
  steps,
  workspaceRoot
}: {
  verification: WorkspaceVerificationSummary
  note?: string
  steps?: readonly import('../types/chat.types').ContentSegment[]
  workspaceRoot?: string | null
}): React.JSX.Element {
  const currentEvidence = verification.evidence.filter(
    (evidence) => evidence.revision === verification.currentRevision
  )
  const authoritative = currentEvidence.at(-1) ?? verification.evidence.at(-1)
  const history = verification.evidence.filter((evidence) => evidence.id !== authoritative?.id)

  return (
    <div className="verification-detail">
      {verification.detail && <p>{verification.detail}</p>}
      {Boolean(steps?.length) && (
        <div className="verification-steps">
          {steps!.map((step, index) =>
            step.type === 'tool' && step.tool ? (
              <ToolExecutionCard key={index} tool={step.tool} workspaceRoot={workspaceRoot} />
            ) : (step.type === 'text' || step.type === 'thinking') && step.content ? (
              <p key={index} className={`verification-step-${step.type}`}>
                {step.type === 'thinking' ? thinkingPreview(step.content) : step.content}
              </p>
            ) : null
          )}
        </div>
      )}
      {authoritative && (
        <ul className="verification-current-evidence">
          <li>
            <span className={`verification-dot ${authoritative.status}`} />
            <span>{authoritative.summary}</span>
            {authoritative.command && <code>{authoritative.command}</code>}
          </li>
        </ul>
      )}
      {history.length > 0 && (
        <details className="verification-history">
          <summary>Earlier attempts ({history.length})</summary>
          <ul>
            {history.slice(-4).map((evidence) => (
              <li key={evidence.id}>
                <span className={`verification-dot ${evidence.status}`} />
                <span>{evidence.summary}</span>
                {evidence.command && <code>{evidence.command}</code>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {note && (
        <div className="verification-note message-content">
          <MessageMarkdown content={note} workspaceRoot={workspaceRoot} />
        </div>
      )}
    </div>
  )
}

/** A verification pass still running, shown live where the reply is being written. */
function VerificationProgress({
  steps,
  workspaceRoot
}: {
  steps?: readonly import('../types/chat.types').ContentSegment[]
  workspaceRoot?: string | null
}): React.JSX.Element {
  return (
    <details className="verification-segment verification-pending">
      <summary>
        <Loader2 size={12} className="spinning" />
        <span>Checking the changes…</span>
        <ChevronDown size={10} className="verification-arrow" />
      </summary>
      <div className="verification-detail">
        {Boolean(steps?.length) && (
          <div className="verification-steps">
            {steps!.map((step, index) =>
              step.type === 'tool' && step.tool ? (
                <ToolExecutionCard key={index} tool={step.tool} workspaceRoot={workspaceRoot} />
              ) : (step.type === 'text' || step.type === 'thinking') && step.content ? (
                <p key={index} className={`verification-step-${step.type}`}>
                  {step.type === 'thinking' ? thinkingPreview(step.content) : step.content}
                </p>
              ) : null
            )}
          </div>
        )}
      </div>
    </details>
  )
}

/**
 * A finished reply's verification result, kept to one line of its footer. Checks are work,
 * not part of the answer; their details open on demand.
 */
function VerificationStatus({
  segment,
  workspaceRoot
}: {
  segment: import('../types/chat.types').ContentSegment
  workspaceRoot?: string | null
}): React.JSX.Element | null {
  const verification = segment.verification
  if (!verification) return null
  // Results saved before SideKick treated a project without any check as not applicable.
  if (
    verification.status === 'unverified' &&
    !verification.evidence.length &&
    !verification.suggestedChecks.length
  ) {
    return null
  }
  const Icon = verification.status === 'passed' ? Check : CircleAlert
  // Saved results carry the wording of their time; these statuses read the same in every reply.
  const copy =
    verification.status === 'stale' || verification.status === 'unverified'
      ? VERIFICATION_STATUS_COPY[verification.status]
      : verification
  return (
    <MessageFooterPopover
      className={`message-verification is-${verification.status}`}
      cardClassName="message-verification-popover"
      title={copy.headline}
      label={
        <>
          <Icon size={11} aria-hidden="true" />
          {VERIFICATION_LABELS[verification.status]}
        </>
      }
    >
      <strong className="message-verification-headline">{copy.headline}</strong>
      <VerificationDetail
        verification={{ ...verification, detail: copy.detail }}
        note={segment.content}
        steps={segment.steps}
        workspaceRoot={workspaceRoot}
      />
    </MessageFooterPopover>
  )
}

function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** A success notice leads with what finished; anything after a blank line is its detail. */
function SystemNoticeBody({
  content,
  emphasizeHeadline
}: {
  content: string
  emphasizeHeadline: boolean
}): React.JSX.Element {
  if (!emphasizeHeadline) return <span className="system-notice-body">{content}</span>
  const breakAt = content.indexOf('\n\n')
  const headline = breakAt < 0 ? content : content.slice(0, breakAt)
  const detail = breakAt < 0 ? '' : content.slice(breakAt + 2).trim()
  // The reply above already says what was done, so the notice is one quiet
  // line. Anything more is evidence, kept closed until it is asked for.
  if (!detail) {
    return (
      <span className="system-notice-body is-single-line">
        <strong>{headline}</strong>
      </span>
    )
  }
  return (
    <details className="system-notice-body system-notice-details">
      <summary>
        <strong>{headline}</strong>
        <ChevronRight size={12} className="system-notice-chevron" aria-hidden="true" />
      </summary>
      <div className="system-notice-detail">{detail}</div>
    </details>
  )
}

function thinkingPreview(content: string): string {
  // Only the opening is shown; normalizing whole reasoning blocks on every
  // render was measurable across the hundreds in a long run.
  const normalized = content.slice(0, 400).replace(/\s+/g, ' ').trim()
  if (!normalized) return 'Thinking'
  const preview = normalized.length > 96 ? `${normalized.slice(0, 95).trimEnd()}…` : normalized
  return `Think · ${preview}`
}

function isDurableOutputGroup(group: GroupedSegment): boolean {
  return (
    group.type === 'content' &&
    (group.segment.type === 'artifact' ||
      group.segment.type === 'verification' ||
      group.segment.type === 'summary' ||
      group.segment.type === 'steer' ||
      // Delegated work is part of the reply, not a step to fold away.
      (group.segment.type === 'tool' &&
        !!group.segment.tool &&
        resolveToolView(group.segment.tool) === 'subagent') ||
      // An interruption is what the reader needs to act on, not work to fold away.
      (group.segment.type === 'run_error' && group.segment.runError?.code === 'interrupted'))
  )
}

/**
 * How many of a work block's most recent steps are mounted. A run that works
 * for hours accumulates hundreds of steps, and the live block is open and
 * re-rendered on every update; mounting all of them made the app slower the
 * longer the agent worked. Earlier steps are one click away.
 */
const WORK_STEPS_SHOWN = 30

function AgentWorkDisclosure({
  messageId,
  isLoading,
  startedAt,
  completedAt,
  children,
  segments,
  awaitingFirstOutput = false,
  showDuration = true,
  runId: _runId
}: {
  messageId: string
  isLoading: boolean
  startedAt?: number
  completedAt?: number
  children?: React.ReactNode
  segments?: readonly import('../types/chat.types').ContentSegment[]
  awaitingFirstOutput?: boolean
  /** A reply split by a sub-agent row has several work groups; one of them carries the time. */
  showDuration?: boolean
  runId?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(isLoading)
  const [showEarlier, setShowEarlier] = useState(false)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!isLoading) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isLoading])

  const endAt = isLoading ? now : (completedAt ?? startedAt ?? now)
  const toolCount = segments?.filter((segment) => segment.type === 'tool').length ?? 0
  const reasoningCount = segments?.filter((segment) => segment.type === 'thinking').length ?? 0
  const activityLabel = [
    toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : '',
    reasoningCount ? `${reasoningCount} thought${reasoningCount === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const durationLabel = startedAt
    ? `${isLoading ? (awaitingFirstOutput ? 'Waiting for model' : 'Working') : 'Worked'} for ${formatWorkDuration(endAt - startedAt)}`
    : 'Worked'
  const label = !showDuration
    ? activityLabel || 'Steps'
    : activityLabel
      ? `${durationLabel} · ${activityLabel}`
      : durationLabel
  const contentId = `${messageId}-agent-work`

  return (
    <div className={`agent-work-disclosure ${isLoading ? 'is-working' : 'is-complete'}`}>
      <button
        type="button"
        className="agent-work-toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <span>{label}</span>
        <ChevronRight size={12} className={expanded ? 'expanded' : ''} aria-hidden="true" />
      </button>
      {expanded && children && (
        <div id={contentId} className="agent-work-content">
          {(() => {
            const steps = Children.toArray(children)
            const earlier = showEarlier ? 0 : Math.max(0, steps.length - WORK_STEPS_SHOWN)
            if (!earlier) return steps
            return (
              <>
                <button
                  type="button"
                  className="agent-work-earlier"
                  onClick={() => setShowEarlier(true)}
                >
                  Show {earlier} earlier {earlier === 1 ? 'step' : 'steps'}
                </button>
                {steps.slice(earlier)}
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

/**
 * Shown below a working reply whose latest output is text. The model may be
 * writing its next tool call, which some servers send only once complete, so
 * minutes can pass with nothing new on screen; this keeps the reply from
 * looking finished.
 */
function AgentWorkingTail({ startedAt }: { startedAt?: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="agent-work-disclosure is-working agent-work-tail" role="status">
      <span className="agent-work-toggle">
        {startedAt ? `Working for ${formatWorkDuration(now - startedAt)}` : 'Working'}
      </span>
    </div>
  )
}

interface MessageItemProps {
  message: Message
  index: number // Reserved for future features (message navigation)
  isLoading: boolean
  expandedThinking: Set<string>
  editingMessageId: string | null
  editingGeometry: MessageEditGeometry | null
  editingContent: string
  copiedMessageId: string | null
  onToggleThinking: (id: string) => void
  onHandleArtifactResult: (
    title: string,
    result: { success: boolean; error?: string; code?: string }
  ) => void
  onEditMessage: (msg: Message, event: React.MouseEvent<HTMLButtonElement>) => void
  onCancelEditMessage: () => void
  onConfirmEditMessage: (msg: Message) => void
  onCopyMessage: (msg: Message) => void
  onRetryMessage: (msg: Message) => void
  /** Continues this interrupted reply; passed only while it can still be continued. */
  onContinueRun?: (msg: Message) => void | Promise<void>
  onForkMessage?: (messageId: string) => void
  onSetEditingContent: (content: string) => void
  onApproveToolLimitDecision: (decisionId: string) => void
  onDenyToolLimitDecision: (decisionId: string) => void
  onResolveAgentInteraction?: (
    interactionId: string,
    response: Record<string, unknown>,
    cancelled?: boolean
  ) => void | Promise<void>
  workspaceFolder?: string | null
  onUndoCheckpoint?: (hash: string) => void
  editActionTitle?: string
  confirmEditActionTitle?: string
  retryActionTitle?: string
  readOnly?: boolean
}

function MessageItemInner({
  message: msg,
  index: _index, // Reserved for future features
  isLoading,
  expandedThinking,
  editingMessageId,
  editingGeometry,
  editingContent,
  copiedMessageId,
  onToggleThinking,
  onHandleArtifactResult,
  onEditMessage,
  onCancelEditMessage,
  onConfirmEditMessage,
  onCopyMessage,
  onRetryMessage,
  onContinueRun,
  onForkMessage,
  onSetEditingContent,
  onApproveToolLimitDecision,
  onDenyToolLimitDecision,
  onResolveAgentInteraction,
  workspaceFolder,
  onUndoCheckpoint,
  editActionTitle = 'Edit message',
  confirmEditActionTitle = 'Save and resend',
  retryActionTitle = 'Rewind and retry from here',
  readOnly = false
}: MessageItemProps) {
  const messageRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const isEditing = editingMessageId === msg.id
  const workStartedAt =
    msg.tokenUsage?.runStartedAt ?? (isLoading || msg.completedAt ? msg.timestamp : undefined)
  const workCompletedAt = msg.tokenUsage?.runCompletedAt ?? msg.completedAt
  const showWorkingTail = isLoading && msg.segments?.[msg.segments.length - 1]?.type === 'text'
  const verificationSegment = msg.segments?.findLast(
    (segment) => segment.type === 'verification' && segment.verification
  )

  useLayoutEffect(() => {
    if (!isEditing) return
    const input = editInputRef.current
    const message = messageRef.current
    if (!input || !message) return
    const scrollContainer = message.closest<HTMLElement>(
      '.messages-container, .group-timeline, .group-agent-transcript'
    )
    input.style.height = '0px'
    input.style.height = `${Math.max(24, input.scrollHeight)}px`
    if (scrollContainer && editingGeometry) {
      const topDelta = message.getBoundingClientRect().top - editingGeometry.viewportTop
      if (Math.abs(topDelta) > 0.5) scrollContainer.scrollTop += topDelta
    }
    input.focus({ preventScroll: true })
    input.setSelectionRange(input.value.length, input.value.length)
  }, [editingGeometry, isEditing])

  useLayoutEffect(() => {
    if (!isEditing || !editInputRef.current) return
    const input = editInputRef.current
    input.style.height = '0px'
    input.style.height = `${Math.max(24, input.scrollHeight)}px`
  }, [editingContent, isEditing])

  return (
    <div
      key={msg.id}
      ref={messageRef}
      className={`message message-${msg.role} ${msg.role === 'system' ? `message-notice message-notice-${msg.noticeTone || 'info'}` : ''} ${msg.peerLabel ? 'message-peer' : ''} ${editingMessageId === msg.id ? 'message-editing' : ''}`}
    >
      <div
        className="message-bubble"
        style={
          isEditing && editingGeometry
            ? {
                width: `${Math.max(320, editingGeometry.width)}px`,
                minHeight: `${editingGeometry.height}px`
              }
            : undefined
        }
      >
        {(msg.senderLabel || msg.peerLabel) && (
          <div className="message-sender">
            <strong>{msg.senderLabel || `From ${msg.peerLabel}`}</strong>
            {msg.senderContext && <span>{msg.senderContext}</span>}
          </div>
        )}
        {msg.role === 'agent' && msg.runMode === 'research' && (
          <div className="message-run-profile">
            <Microscope size={12} aria-hidden="true" />
            <span>Research report</span>
          </div>
        )}
        {msg.role === 'agent' && msg.runMode === 'plan' && (
          <div className="message-run-profile">
            <ListChecks size={12} aria-hidden="true" />
            <span>Plan → Act</span>
          </div>
        )}
        {Boolean(msg.attachments?.some(isPastedTextAttachment)) && (
          <div className="message-pasted-texts" aria-label="Pasted text">
            {msg.attachments!.filter(isPastedTextAttachment).map((attachment) => (
              <PastedTextAttachmentCard key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        {Boolean(msg.attachments?.some(isProjectContextAttachment)) && (
          <div className="message-context-attachments" aria-label="Attached files and folders">
            {msg.attachments!.filter(isProjectContextAttachment).map((attachment) => (
              <button
                type="button"
                key={attachment.id}
                title={`Open ${attachment.relativePath}`}
                onClick={(event) => {
                  event.stopPropagation()
                  const open =
                    attachment.kind === 'folder'
                      ? window.api.workspace.openFolder
                      : window.api.workspace.openFile
                  void open(attachment.relativePath, workspaceFolder || undefined)
                }}
              >
                {attachment.kind === 'folder' ? (
                  <FolderOpen size={14} aria-hidden="true" />
                ) : (
                  <FileText size={14} aria-hidden="true" />
                )}
                <span>{attachment.name}</span>
              </button>
            ))}
          </div>
        )}
        {Boolean(msg.attachments?.some(isReviewCommentAttachment)) && (
          <div className="message-context-attachments" aria-label="Comments on changed lines">
            {msg.attachments!.filter(isReviewCommentAttachment).map((attachment) => (
              <button
                type="button"
                key={attachment.id}
                className="message-review-comment"
                title={`${attachment.path}:${reviewCommentLineLabel(attachment.startLine, attachment.endLine)}\n${attachment.comment}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void window.api.workspace.openFile(attachment.path, workspaceFolder || undefined)
                }}
              >
                <MessageSquareText size={14} aria-hidden="true" />
                <span>
                  <strong>{attachment.name}</strong> {attachment.comment}
                </span>
              </button>
            ))}
          </div>
        )}
        {Boolean(msg.images?.length) && (
          <div className="message-image-attachments" aria-label="Attached images">
            {msg.images!.map((image) => (
              <ImageAttachmentPreview
                key={image.id}
                image={image}
                className="message-image-preview"
              />
            ))}
          </div>
        )}
        {/* Show loading animation only when: no content, no thinking, no segments, and still loading */}
        {msg.role === 'agent' &&
          !msg.content &&
          !msg.thinking &&
          !msg.segments?.length &&
          isLoading && (
            <AgentWorkDisclosure
              key={`${msg.id}:working`}
              messageId={msg.id}
              isLoading
              startedAt={workStartedAt}
              awaitingFirstOutput
            />
          )}

        {msg.role === 'system' ? (
          <div className="system-notice" role={msg.noticeTone === 'error' ? 'alert' : 'status'}>
            <span className="system-notice-icon" aria-hidden="true">
              {msg.noticeTone === 'error' ? (
                <CircleAlert size={14} />
              ) : msg.noticeTone === 'success' ? (
                <CircleCheck size={14} />
              ) : (
                <Info size={14} />
              )}
            </span>
            <SystemNoticeBody
              content={
                // Earlier goal notices repeated the objective in their headline.
                msg.id.startsWith('goal-complete:')
                  ? msg.content.replace(/^Goal complete — [^\n]*/, 'Goal complete')
                  : msg.content
              }
              emphasizeHeadline={msg.noticeTone === 'success'}
            />
          </div>
        ) : msg.segments && msg.segments.length > 0 ? (
          <div className="message-segments">
            {(() => {
              const groupedSegments = groupSegments(msg.segments)
              // A model that fixes or revises an artifact makes it again under the
              // same title. Only the latest one is the result; the attempts it
              // replaced are work, and showing each one stacked the chat with
              // broken and outdated copies.
              const latestArtifactByTitle = new Map<string, unknown>()
              for (const segment of msg.segments) {
                if (segment.type === 'artifact' && segment.artifact) {
                  latestArtifactByTitle.set(segment.artifact.title, segment)
                }
              }
              const lastWorkIndex = groupedSegments.findLastIndex(isWorkSegmentGroup)
              const finalAnswerIndex = groupedSegments.findIndex(
                (group, groupIndex) =>
                  groupIndex > lastWorkIndex &&
                  group.type === 'content' &&
                  group.segment.type === 'text' &&
                  Boolean(group.segment.content?.trim())
              )
              const workEnd =
                lastWorkIndex < 0
                  ? 0
                  : finalAnswerIndex >= 0
                    ? finalAnswerIndex
                    : groupedSegments.length
              const renderedGroups = groupedSegments.map((group, groupIdx) => (
                <div key={groupIdx} className="segment-group">
                  {group.type === 'actions' ? (
                    // Preserve the provider's real thinking/tool chronology.
                    <div className="actions-group">
                      {group.segments.map((segment, segIdx) => {
                        if (segment.type === 'tool') {
                          return (
                            <div key={`tool-${segIdx}`} className="action-item">
                              {segment.tool && (
                                <ToolExecutionCard
                                  tool={segment.tool}
                                  workspaceRoot={workspaceFolder}
                                />
                              )}
                              {!segment.tool && segment.content && (
                                <ToolCallRow
                                  tool={{
                                    id: `${msg.id}-${groupIdx}-${segIdx}`,
                                    title: segment.content,
                                    command: '',
                                    status: 'running'
                                  }}
                                />
                              )}
                            </div>
                          )
                        }
                        if (segment.type !== 'thinking' || !segment.content) return null
                        const thinkingId = `${msg.id}-group-${groupIdx}-thinking-${segIdx}`
                        return (
                          <div key={`thinking-${segIdx}`} className="action-thinking-step">
                            <button
                              className="actions-toggle"
                              onClick={() => onToggleThinking(thinkingId)}
                              aria-expanded={expandedThinking.has(thinkingId)}
                              title="Show or hide thinking"
                            >
                              <ChevronRight
                                size={11}
                                className={`toggle-icon ${expandedThinking.has(thinkingId) ? 'expanded' : ''}`}
                              />
                              <span className="actions-summary">
                                {thinkingPreview(segment.content)}
                              </span>
                            </button>
                            {expandedThinking.has(thinkingId) && (
                              <div className="actions-content">
                                <div className="action-item">
                                  <div className="action-thinking">
                                    <div className="action-text">
                                      <MessageMarkdown
                                        content={segment.content}
                                        richMedia={false}
                                        workspaceRoot={workspaceFolder}
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : group.type === 'content' &&
                    group.segment.type === 'decision' &&
                    group.segment.decision ? (
                    <div
                      className={`tool-limit-decision tool-limit-decision-${group.segment.decision.status}`}
                    >
                      <div className="tool-limit-decision-title">
                        {group.segment.decision.isLoopGuard
                          ? 'Repetitive tool calls detected'
                          : 'Tool limit reached'}
                      </div>
                      <div className="tool-limit-decision-text">
                        {group.segment.decision.prompt}
                      </div>
                      {!group.segment.decision.isLoopGuard && (
                        <div className="tool-limit-decision-meta">
                          Used {group.segment.decision.roundsUsed} of{' '}
                          {group.segment.decision.currentLimit} rounds
                        </div>
                      )}
                      {group.segment.decision.status === 'pending' ? (
                        <div className="tool-limit-decision-actions">
                          <button
                            type="button"
                            className="tool-limit-decision-button approve"
                            onClick={() => onApproveToolLimitDecision(group.segment.decision!.id)}
                          >
                            {group.segment.decision.isLoopGuard
                              ? 'Continue anyway'
                              : `Allow ${group.segment.decision.requestedAdditionalRounds} more`}
                          </button>
                          <button
                            type="button"
                            className="tool-limit-decision-button deny"
                            onClick={() => onDenyToolLimitDecision(group.segment.decision!.id)}
                          >
                            Stop here
                          </button>
                        </div>
                      ) : (
                        <div
                          className={`tool-limit-decision-status tool-limit-decision-status-${group.segment.decision.status}`}
                        >
                          {group.segment.decision.status === 'approved'
                            ? group.segment.decision.isLoopGuard
                              ? 'Continued'
                              : `Approved ${group.segment.decision.requestedAdditionalRounds} more rounds`
                            : 'Stopped at the current tool limit'}
                        </div>
                      )}
                    </div>
                  ) : group.type === 'content' &&
                    group.segment.type === 'interaction' &&
                    group.segment.interaction &&
                    onResolveAgentInteraction ? (
                    <AgentInteractionCard
                      interaction={group.segment.interaction}
                      onResolve={onResolveAgentInteraction}
                    />
                  ) : group.type === 'content' &&
                    group.segment.type === 'run_status' &&
                    group.segment.status ? (
                    <RunStatusSegment status={group.segment.status} />
                  ) : group.type === 'content' &&
                    group.segment.type === 'run_error' &&
                    group.segment.runError ? (
                    <RunErrorSegment
                      error={group.segment.runError}
                      onRetry={() => onRetryMessage(msg)}
                      onContinue={onContinueRun ? () => onContinueRun(msg) : undefined}
                    />
                  ) : group.type === 'content' &&
                    group.segment.type === 'steer' &&
                    group.segment.steer ? (
                    <SteerSegment steer={group.segment.steer} />
                  ) : group.type === 'content' &&
                    group.segment.type === 'artifact' &&
                    group.segment.artifact ? (
                    latestArtifactByTitle.get(group.segment.artifact.title) !==
                    group.segment ? null : (
                      // Standalone artifact (not grouped with thinking)
                      <div className="artifact-segment">
                        <Artifact
                          artifact={group.segment.artifact}
                          onResult={(result) =>
                            onHandleArtifactResult(group.segment.artifact!.title, result)
                          }
                        />
                      </div>
                    )
                  ) : group.type === 'content' &&
                    group.segment.type === 'tool' &&
                    group.segment.tool ? (
                    // Standalone tool (pending approval or sub-agent row)
                    resolveToolView(group.segment.tool) === 'subagent' ? (
                      <SubAgentCard tool={group.segment.tool} />
                    ) : (
                      <ToolCallRow tool={group.segment.tool} />
                    )
                  ) : group.type === 'content' &&
                    group.segment.type === 'text' &&
                    group.segment.content ? (
                    // Standalone text content
                    <div
                      className="message-content"
                      data-final-answer={groupIdx === finalAnswerIndex ? '' : undefined}
                    >
                      <MessageMarkdown
                        content={group.segment.content}
                        isStreaming={isLoading}
                        workspaceRoot={workspaceFolder}
                        onArtifactResult={onHandleArtifactResult}
                      />
                    </div>
                  ) : group.type === 'content' && group.segment.type === 'summarizing' ? (
                    // Loading indicator for context summarization - same style as final summary
                    <div className="summary-segment-compact summarizing-loading">
                      <Loader2 className="summary-icon spinning" size={12} />
                      <span className="summary-text">{group.segment.content}</span>
                    </div>
                  ) : group.type === 'content' &&
                    group.segment.type === 'verification' &&
                    group.segment.verification ? (
                    group.segment.pending && isLoading ? (
                      <VerificationProgress
                        steps={group.segment.steps}
                        workspaceRoot={workspaceFolder}
                      />
                    ) : finalAnswerIndex < 0 && group.segment.content?.trim() ? (
                      // Replies saved before the kernel kept such a reply as the answer hold
                      // their only answer here.
                      <div className="message-content">
                        <MessageMarkdown
                          content={group.segment.content}
                          workspaceRoot={workspaceFolder}
                          onArtifactResult={onHandleArtifactResult}
                        />
                      </div>
                    ) : null
                  ) : group.type === 'content' &&
                    group.segment.type === 'summary' &&
                    group.segment.summary ? (
                    <CompactionSummarySegment
                      summary={group.segment.summary}
                      modelContext={group.segment.content}
                    />
                  ) : null}
                </div>
              ))
              if (lastWorkIndex < 0) return renderedGroups
              const workGroupIndexes = new Set(
                groupedSegments
                  .map((group, groupIndex) => ({ group, groupIndex }))
                  .filter(
                    ({ group, groupIndex }) => groupIndex < workEnd && !isDurableOutputGroup(group)
                  )
                  .map(({ groupIndex }) => groupIndex)
              )
              const blocks = chunkGroupsChronologically(groupedSegments, (_group, groupIndex) =>
                workGroupIndexes.has(groupIndex)
              )
              const output: React.ReactNode[] = []
              let changeReviewRendered = false
              const appendChangeReview = (): void => {
                if (changeReviewRendered) return
                output.push(
                  <TurnChangeReview
                    key={`${msg.id}:change-review`}
                    segments={msg.segments || []}
                    workspaceRoot={workspaceFolder}
                  />
                )
                changeReviewRendered = true
              }

              // The time goes on the work nearest the answer, or on the live line below it.
              const timedBlock = showWorkingTail
                ? -1
                : blocks.findLastIndex((block) => block.type === 'work')
              blocks.forEach((block, blockIndex) => {
                const firstGroupIndex =
                  block.type === 'work' ? block.groups[0]!.groupIndex : block.groupIndex
                if (firstGroupIndex >= workEnd) appendChangeReview()

                if (block.type === 'content') {
                  output.push(renderedGroups[block.groupIndex])
                  return
                }

                const blockSegments = block.groups.flatMap(({ group }) =>
                  group.type === 'actions' ? group.segments : [group.segment]
                )
                output.push(
                  <AgentWorkDisclosure
                    key={`${msg.id}:work:${firstGroupIndex}`}
                    messageId={`${msg.id}-work-${firstGroupIndex}`}
                    isLoading={isLoading}
                    startedAt={workStartedAt}
                    completedAt={workCompletedAt}
                    segments={blockSegments}
                    showDuration={blockIndex === timedBlock}
                    runId={msg.runId}
                  >
                    {block.groups.map(({ groupIndex }) => renderedGroups[groupIndex])}
                  </AgentWorkDisclosure>
                )
              })
              appendChangeReview()
              return output
            })()}
            {showWorkingTail && <AgentWorkingTail startedAt={workStartedAt} />}
          </div>
        ) : msg.role === 'agent' && msg.thinking ? (
          // Legacy format: separate thinking and content
          <>
            <AgentWorkDisclosure
              key={`${msg.id}:${isLoading ? 'working' : 'worked'}`}
              messageId={msg.id}
              isLoading={isLoading}
              startedAt={workStartedAt}
              completedAt={workCompletedAt}
            >
              <div className="thinking-content">
                <MessageMarkdown
                  content={msg.thinking}
                  richMedia={false}
                  workspaceRoot={workspaceFolder}
                />
              </div>
            </AgentWorkDisclosure>
            <div className="message-content">
              <MessageMarkdown
                content={msg.content}
                isStreaming={isLoading}
                workspaceRoot={workspaceFolder}
                onArtifactResult={onHandleArtifactResult}
              />
            </div>
          </>
        ) : editingMessageId === msg.id ? (
          // Editing mode - just textarea, save/cancel via icons in message-meta
          <textarea
            ref={editInputRef}
            className="message-edit-input"
            value={editingContent}
            onChange={(event) => {
              event.currentTarget.style.height = '0px'
              event.currentTarget.style.height = `${Math.max(24, event.currentTarget.scrollHeight)}px`
              onSetEditingContent(event.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                onConfirmEditMessage(msg)
              }
              if (e.key === 'Escape') {
                onCancelEditMessage()
              }
            }}
            rows={2}
            disabled={isLoading}
          />
        ) : (
          // Normal message rendering
          <div className="message-content">
            <MessageMarkdown
              content={msg.content}
              isStreaming={isLoading && msg.role === 'agent'}
              workspaceRoot={workspaceFolder}
              onArtifactResult={onHandleArtifactResult}
            />
          </div>
        )}
      </div>
      {msg.role === 'agent' && !isLoading && !readOnly && (
        <MessageSources
          content={
            msg.segments?.length
              ? msg.segments
                  .map((segment) => (segment.type === 'text' ? segment.content : ''))
                  .join('\n')
              : msg.content
          }
        />
      )}
      {/* A working reply has no totals or finish time yet; showing them made it look done. */}
      {msg.role !== 'system' && !(msg.role === 'agent' && isLoading) && (
        <div className="message-meta">
          <div className="message-info">
            {msg.role === 'agent' && msg.tokenUsage && (
              <MessageFooterPopover
                className="message-run-stats"
                cardClassName="message-run-stats-popover"
                title="Show response metrics"
                label={
                  <>
                    {(
                      msg.tokenUsage.promptTokens + msg.tokenUsage.completionTokens
                    ).toLocaleString()}{' '}
                    tokens
                    {workStartedAt && workCompletedAt
                      ? ` · ${formatWorkDuration(workCompletedAt - workStartedAt)}`
                      : ''}
                  </>
                }
              >
                <span>
                  Input <strong>{msg.tokenUsage.promptTokens.toLocaleString()}</strong>
                </span>
                <span>
                  Output <strong>{msg.tokenUsage.completionTokens.toLocaleString()}</strong>
                </span>
                {msg.tokenUsage.cachedPromptTokens !== undefined && (
                  <span>
                    Cached{' '}
                    <strong>
                      {msg.tokenUsage.cachedPromptTokens.toLocaleString()}
                      {msg.tokenUsage.promptTokens > 0
                        ? ` (${Math.round(
                            (msg.tokenUsage.cachedPromptTokens / msg.tokenUsage.promptTokens) * 100
                          )}%)`
                        : ''}
                    </strong>
                  </span>
                )}
                {msg.tokenUsage.timeToFirstTokenMs !== undefined && (
                  <span>
                    First output{' '}
                    <strong>
                      {msg.tokenUsage.timeToFirstTokenMs < 1_000
                        ? `${Math.round(msg.tokenUsage.timeToFirstTokenMs)} ms`
                        : `${(msg.tokenUsage.timeToFirstTokenMs / 1_000).toFixed(1)} s`}
                    </strong>
                  </span>
                )}
                {msg.tokenUsage.tokensPerSecond !== undefined && (
                  <span>
                    Speed <strong>{msg.tokenUsage.tokensPerSecond.toFixed(1)} t/s</strong>
                  </span>
                )}
                {msg.tokenUsage.cost !== undefined && (
                  <span>
                    Cost <strong>${msg.tokenUsage.cost.toFixed(4)}</strong>
                  </span>
                )}
                {!!msg.tokenUsage.providerTimings?.length && (
                  <details>
                    <summary>
                      Model request timeline ({msg.tokenUsage.providerTimings.length})
                    </summary>
                    <p>
                      Wait includes network, server queue and prefill; these are not separately
                      measured. Stream time includes reasoning and output.
                    </p>
                    <ol>
                      {msg.tokenUsage.providerTimings.map((timing, index) => (
                        <li key={index}>
                          Request {index + 1}: {(timing.durationMs / 1000).toFixed(1)} s total ·
                          wait{' '}
                          {timing.timeToFirstTokenMs === undefined
                            ? 'not reported'
                            : `${(timing.timeToFirstTokenMs / 1000).toFixed(1)} s`}{' '}
                          · stream{' '}
                          {timing.timeToFirstTokenMs === undefined
                            ? 'not reported'
                            : `${(Math.max(0, timing.durationMs - timing.timeToFirstTokenMs) / 1000).toFixed(1)} s`}{' '}
                          · input {timing.promptTokens.toLocaleString()} · cached{' '}
                          {timing.cachedPromptTokens?.toLocaleString() ?? 'not reported'}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </MessageFooterPopover>
            )}
            {msg.role === 'agent' && verificationSegment && (
              <VerificationStatus
                segment={
                  // A reply saved with its answer in the note shows that note as the answer.
                  finalAnswerText(msg).trim()
                    ? verificationSegment
                    : { ...verificationSegment, content: undefined }
                }
                workspaceRoot={workspaceFolder}
              />
            )}
            <div className="message-timestamp">
              {formatTimestamp(msg.timestamp)}
              {msg.role === 'agent' &&
                msg.tokenUsage?.tokensPerSecond !== undefined &&
                msg.tokenUsage.tokensPerSecond > 0 && (
                  <span className="message-token-info" title="Generation speed">
                    {msg.tokenUsage.tokensPerSecond.toFixed(1)} t/s
                  </span>
                )}
            </div>
          </div>
          {msg.role === 'user' && (
            <div className="message-actions">
              {editingMessageId === msg.id ? (
                <>
                  <button
                    type="button"
                    className="message-action icon"
                    onClick={() => onConfirmEditMessage(msg)}
                    title={confirmEditActionTitle}
                    aria-label={confirmEditActionTitle}
                    disabled={isLoading}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    className="message-action icon"
                    onClick={onCancelEditMessage}
                    title="Cancel edit"
                    aria-label="Cancel edit"
                    disabled={isLoading}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`message-action icon ${copiedMessageId === msg.id ? 'copied-icon' : 'copy-icon'}`}
                    onClick={() => onCopyMessage(msg)}
                    title={copiedMessageId === msg.id ? 'Copied!' : 'Copy message'}
                    aria-label={copiedMessageId === msg.id ? 'Copied' : 'Copy message'}
                  >
                    {copiedMessageId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  <ReadAloudButton messageId={msg.id} text={msg.content} />
                  {!readOnly && (
                    <>
                      <button
                        type="button"
                        className="message-action icon"
                        onClick={(e) => onEditMessage(msg, e)}
                        title={editActionTitle}
                        aria-label={editActionTitle}
                        disabled={isLoading}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="message-action icon"
                        onClick={() => onRetryMessage(msg)}
                        title={retryActionTitle}
                        aria-label={retryActionTitle}
                        disabled={isLoading}
                      >
                        <RotateCcw size={13} />
                      </button>
                      {onForkMessage && (
                        <button
                          type="button"
                          className="message-action icon"
                          onClick={() => onForkMessage(msg.id)}
                          title="Fork from this message"
                          aria-label="Fork from this message"
                          disabled={isLoading}
                        >
                          <GitBranch size={13} />
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {msg.role === 'agent' && (
            <div className="message-actions">
              <button
                type="button"
                className={`message-action icon ${copiedMessageId === msg.id ? 'copied-icon' : 'copy-icon'}`}
                onClick={() => onCopyMessage(msg)}
                title={copiedMessageId === msg.id ? 'Copied!' : 'Copy message'}
                aria-label={copiedMessageId === msg.id ? 'Copied' : 'Copy message'}
              >
                {copiedMessageId === msg.id ? <Check size={13} /> : <Copy size={13} />}
              </button>
              {!isLoading && <ReadAloudButton messageId={msg.id} text={finalAnswerText(msg)} />}
              {!readOnly && onForkMessage && (
                <button
                  type="button"
                  className="message-action icon"
                  onClick={() => onForkMessage(msg.id)}
                  title="Fork from this message"
                  aria-label="Fork from this message"
                  disabled={isLoading}
                >
                  <GitBranch size={13} />
                </button>
              )}
              {!readOnly &&
                msg.checkpointHash &&
                msg.checkpointWorkspaceRoot === workspaceFolder &&
                onUndoCheckpoint && (
                  <button
                    type="button"
                    className="message-action icon"
                    onClick={() => onUndoCheckpoint(msg.checkpointHash!)}
                    title={
                      msg.restoredFrom === msg.checkpointHash
                        ? 'Changes already undone'
                        : 'Undo file changes from this response'
                    }
                    aria-label={
                      msg.restoredFrom === msg.checkpointHash
                        ? 'Changes already undone'
                        : 'Undo file changes'
                    }
                    disabled={isLoading || msg.restoredFrom === msg.checkpointHash}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Memoized export: only re-renders when message data or directly relevant props change.
// This prevents O(n) re-renders of the entire message list on every streamed token —
// only the actively-streaming message (whose content/segments change) will re-render.
export const MessageItem = memo(MessageItemInner, (prev, next) => {
  // Always re-render if the message object changed (content, segments, thinking, tokenUsage)
  if (prev.message !== next.message) return false
  // Re-render if loading state changed (affects the typing indicator on the last message)
  if (prev.isLoading !== next.isLoading) return false
  if (prev.readOnly !== next.readOnly) return false
  if (prev.onForkMessage !== next.onForkMessage) return false
  if (prev.onContinueRun !== next.onContinueRun) return false
  // Re-render if this message is being edited or stopped being edited
  if (
    prev.editingMessageId !== next.editingMessageId &&
    (prev.editingMessageId === prev.message.id || next.editingMessageId === next.message.id)
  )
    return false
  // Re-render if editing content changed for this message
  if (prev.editingMessageId === prev.message.id && prev.editingContent !== next.editingContent)
    return false
  // Re-render if copied state changed for this message
  if (
    prev.copiedMessageId !== next.copiedMessageId &&
    (prev.copiedMessageId === prev.message.id || next.copiedMessageId === next.message.id)
  )
    return false
  // Re-render if thinking expansion changed for this message
  if (prev.expandedThinking !== next.expandedThinking) {
    const prefix = `${prev.message.id}-`
    const previousKeys = [...prev.expandedThinking].filter((key) => key.startsWith(prefix))
    const nextKeys = [...next.expandedThinking].filter((key) => key.startsWith(prefix))
    if (
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key) => !next.expandedThinking.has(key)) ||
      nextKeys.some((key) => !prev.expandedThinking.has(key))
    )
      return false
  }
  // All relevant props are equal — skip re-render
  return true
})
