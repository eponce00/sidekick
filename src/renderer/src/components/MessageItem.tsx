import { useState, useRef, useEffect, useLayoutEffect, memo } from 'react'
import {
  Loader2,
  Check,
  X,
  AlignLeft,
  ChevronDown,
  ChevronRight,
  Search,
  Globe,
  Terminal,
  MessageSquare,
  Copy,
  Pencil,
  RotateCcw,
  Info,
  CircleAlert,
  ListChecks,
  Microscope
} from 'lucide-react'
import { formatTimestamp } from '../utils/messageFormatting'
import { groupSegments } from '../utils/segmentGrouping'
import Artifact from './artifacts/Artifact'
import ToolCallRow from './ToolCallRow'
import AgentInteractionCard from './AgentInteractionCard'
import { MessageMarkdown } from './MessageMarkdown'
import type { Message, MessageEditGeometry, ToolExecution } from '../types/chat.types'
import type { GroupedSegment } from '../types/chat.types'
import type { SubAgentStep } from '../types/subagent.types'

/** Renders the sub-agent mini-chat showing step-by-step execution */
function SubAgentMiniChat({ steps }: { steps: SubAgentStep[] }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [steps.length])

  return (
    <div className="sa-steps" ref={scrollRef}>
      {steps.map((step, i) => (
        <div key={i} className={`sa-step sa-step--${step.type}`}>
          <span className={`sa-step__icon ${step.status ? `sa-step__icon--${step.status}` : ''}`}>
            {step.type === 'tool_call' ? (
              step.name === 'web_search' ? (
                <Search size={11} />
              ) : step.name === 'web_fetch' ? (
                <Globe size={11} />
              ) : step.name === 'execute_command' ? (
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

/** Renders sub-agent progress as a compact tool row with optional inline detail. */
function SubAgentCard({ tool }: { tool: ToolExecution }): React.JSX.Element {
  const [expanded, setExpanded] = useState(tool.status === 'running')
  const hasSteps = tool.subAgentSteps && tool.subAgentSteps.length > 0
  const isRunning = tool.status === 'running'
  const canExpand = hasSteps || isRunning

  // Auto-expand while running, auto-collapse when done (if user hasn't manually toggled)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (isRunning && !wasRunning.current) {
      wasRunning.current = true
      const timer = window.setTimeout(() => setExpanded(true), 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [isRunning])

  return (
    <div className={`sa-inline sa-inline-${tool.status}`}>
      <ToolCallRow
        tool={tool}
        onSelect={canExpand ? () => setExpanded(!expanded) : undefined}
        expandable={canExpand}
        expanded={expanded}
      />

      {!expanded && tool.output && <div className="sa-inline__summary">{tool.output}</div>}

      {expanded && (
        <div className="sa-inline__body">
          {hasSteps ? (
            <SubAgentMiniChat steps={tool.subAgentSteps!} />
          ) : isRunning ? (
            <div className="sa-inline__waiting">
              <Loader2 size={12} className="icon-spin" />
              <span>Working...</span>
            </div>
          ) : null}
          {tool.error && <div className="sa-inline__error">{tool.error}</div>}
        </div>
      )}
    </div>
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

function isWorkSegmentGroup(group: GroupedSegment): boolean {
  if (group.type === 'actions') return true
  return ['tool', 'summary', 'summarizing', 'decision', 'interaction'].includes(group.segment.type)
}

function AgentWorkDisclosure({
  messageId,
  isLoading,
  startedAt,
  completedAt,
  children
}: {
  messageId: string
  isLoading: boolean
  startedAt?: number
  completedAt?: number
  children?: React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(isLoading)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!isLoading) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isLoading])

  const endAt = isLoading ? now : (completedAt ?? startedAt ?? now)
  const label = startedAt
    ? `${isLoading ? 'Working' : 'Worked'} for ${formatWorkDuration(endAt - startedAt)}`
    : 'Worked'
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
          {children}
        </div>
      )}
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
  onSetEditingContent: (content: string) => void
  onApproveToolLimitDecision: (decisionId: string) => void
  onDenyToolLimitDecision: (decisionId: string) => void
  onResolveAgentInteraction?: (
    interactionId: string,
    response: Record<string, unknown>,
    cancelled?: boolean
  ) => void
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
  onSetEditingContent,
  onApproveToolLimitDecision,
  onDenyToolLimitDecision,
  onResolveAgentInteraction,
  workspaceFolder: _workspaceFolder,
  onUndoCheckpoint: _onUndoCheckpoint,
  editActionTitle = 'Edit message',
  confirmEditActionTitle = 'Save and resend',
  retryActionTitle = 'Retry message',
  readOnly = false
}: MessageItemProps) {
  const messageRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const isEditing = editingMessageId === msg.id
  const workStartedAt =
    msg.tokenUsage?.runStartedAt ?? (isLoading || msg.completedAt ? msg.timestamp : undefined)
  const workCompletedAt = msg.tokenUsage?.runCompletedAt ?? msg.completedAt

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
            />
          )}

        {msg.role === 'system' ? (
          <div className="system-notice" role={msg.noticeTone === 'error' ? 'alert' : 'status'}>
            <span className="system-notice-icon" aria-hidden="true">
              {msg.noticeTone === 'error' ? <CircleAlert size={14} /> : <Info size={14} />}
            </span>
            <span>{msg.content}</span>
          </div>
        ) : msg.segments && msg.segments.length > 0 ? (
          <div className="message-segments">
            {(() => {
              const groupedSegments = groupSegments(msg.segments)
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
                    // Tool calls always visible; thinking collapsible
                    <div className="actions-group">
                      {/* Always-visible tool call rows */}
                      {group.toolSegments.length > 0 && (
                        <div className="actions-tools">
                          {group.toolSegments.map((segment, segIdx) => (
                            <div key={segIdx} className="action-item">
                              {segment.tool &&
                                (segment.tool.command === 'spawn_subagent' ? (
                                  <SubAgentCard tool={segment.tool} />
                                ) : (
                                  <ToolCallRow tool={segment.tool} />
                                ))}
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
                          ))}
                        </div>
                      )}

                      {/* Collapsible thinking section */}
                      {group.thinkingSegments.length > 0 && (
                        <>
                          <button
                            className="actions-toggle"
                            onClick={() => onToggleThinking(`${msg.id}-group-${groupIdx}`)}
                            aria-expanded={expandedThinking.has(`${msg.id}-group-${groupIdx}`)}
                            title="Show or hide thinking"
                          >
                            <ChevronRight
                              size={11}
                              className={`toggle-icon ${expandedThinking.has(`${msg.id}-group-${groupIdx}`) ? 'expanded' : ''}`}
                            />
                            <span className="actions-summary">
                              {group.thinkingSegments.length} thinking
                            </span>
                          </button>

                          {expandedThinking.has(`${msg.id}-group-${groupIdx}`) && (
                            <div className="actions-content">
                              {group.thinkingSegments.map((segment, segIdx) => (
                                <div key={segIdx} className="action-item">
                                  {segment.content && (
                                    <div className="action-thinking">
                                      <span className="action-label">Thinking</span>
                                      <div className="action-text">
                                        <MessageMarkdown
                                          content={segment.content}
                                          richMedia={false}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
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
                    group.segment.type === 'artifact' &&
                    group.segment.artifact ? (
                    // Standalone artifact (not grouped with thinking)
                    <div className="artifact-segment">
                      <Artifact
                        artifact={group.segment.artifact}
                        onResult={(result) =>
                          onHandleArtifactResult(group.segment.artifact!.title, result)
                        }
                      />
                    </div>
                  ) : group.type === 'content' &&
                    group.segment.type === 'tool' &&
                    group.segment.tool ? (
                    // Standalone tool (pending approval or sub-agent card)
                    group.segment.tool.command === 'spawn_subagent' ? (
                      <SubAgentCard tool={group.segment.tool} />
                    ) : (
                      <ToolCallRow tool={group.segment.tool} />
                    )
                  ) : group.type === 'content' &&
                    group.segment.type === 'text' &&
                    group.segment.content ? (
                    // Standalone text content
                    <div className="message-content">
                      <MessageMarkdown
                        content={group.segment.content}
                        isStreaming={isLoading}
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
                    <details
                      className={`verification-segment verification-${group.segment.verification.status}`}
                    >
                      <summary>
                        {group.segment.verification.status === 'passed' ? (
                          <Check size={12} />
                        ) : (
                          <CircleAlert size={12} />
                        )}
                        <span>{group.segment.verification.headline}</span>
                        <ChevronDown size={10} className="verification-arrow" />
                      </summary>
                      <div className="verification-detail">
                        {group.segment.verification.detail && (
                          <p>{group.segment.verification.detail}</p>
                        )}
                        {group.segment.verification.evidence.length > 0 && (
                          <ul>
                            {group.segment.verification.evidence.slice(-4).map((evidence) => (
                              <li key={evidence.id}>
                                <span className={`verification-dot ${evidence.status}`} />
                                <span>{evidence.summary}</span>
                                {evidence.command && <code>{evidence.command}</code>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  ) : group.type === 'content' &&
                    group.segment.type === 'summary' &&
                    group.segment.summary ? (
                    // Context summarization indicator - compact inline version
                    <div className="summary-segment-compact">
                      <AlignLeft className="summary-icon" size={12} />
                      <span className="summary-text">
                        Context compacted: {group.segment.summary.messagesCompacted} msgs,{' '}
                        {Math.round(
                          Math.max(
                            0,
                            Math.min(
                              1,
                              1 -
                                group.segment.summary.newTokens /
                                  Math.max(group.segment.summary.originalTokens, 1)
                            )
                          ) * 100
                        )}
                        % saved
                      </span>
                      {group.segment.content && (
                        <details className="summary-details">
                          <summary>
                            <ChevronDown className="summary-arrow" size={10} />
                          </summary>
                          <div className="summary-content">
                            <MessageMarkdown content={group.segment.content} richMedia={false} />
                          </div>
                        </details>
                      )}
                    </div>
                  ) : null}
                </div>
              ))
              if (lastWorkIndex < 0) return renderedGroups
              return (
                <>
                  <AgentWorkDisclosure
                    key={`${msg.id}:${isLoading ? 'working' : 'worked'}`}
                    messageId={msg.id}
                    isLoading={isLoading}
                    startedAt={workStartedAt}
                    completedAt={workCompletedAt}
                  >
                    {renderedGroups.slice(0, workEnd)}
                  </AgentWorkDisclosure>
                  {renderedGroups.slice(workEnd)}
                </>
              )
            })()}
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
                <MessageMarkdown content={msg.thinking} richMedia={false} />
              </div>
            </AgentWorkDisclosure>
            <div className="message-content">
              <MessageMarkdown
                content={msg.content}
                isStreaming={isLoading}
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
              onArtifactResult={onHandleArtifactResult}
            />
          </div>
        )}
      </div>
      {msg.role !== 'system' && (
        <div className="message-meta">
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
            </div>
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
    const msgId = prev.message.id
    const wasExpanded = [...prev.expandedThinking].some((k) => k.startsWith(msgId))
    const isExpanded = [...next.expandedThinking].some((k) => k.startsWith(msgId))
    if (wasExpanded !== isExpanded) return false
  }
  // All relevant props are equal — skip re-render
  return true
})
