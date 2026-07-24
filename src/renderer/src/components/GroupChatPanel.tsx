import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Check,
  CircleStop,
  LoaderCircle,
  PanelRight,
  Pause,
  Play,
  Plus,
  Square,
  Users
} from 'lucide-react'
import type { CollaborationGroupDetail } from '../../../shared/collaboration'
import type { Message, MessageEditGeometry } from '../types/chat.types'
import type { PinnedModel } from '../types/models.types'
import { projectGroupChannelMessages } from '../utils/groupChannelProjection'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { ChatComposer } from './ChatComposer'
import { ChatModelPicker } from './ChatModelPicker'
import { AgentMentionMenu } from './AgentMentionMenu'
import GroupAgentConversation from './GroupAgentConversation'
import { GroupWorkspacePanel } from './GroupWorkspacePanel'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { MessageItem } from './MessageItem'
import { pinnedModelForProviderTarget, providerTargetForPinnedModel } from '../utils/providerTarget'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { promptRefinementModelForTarget } from '../services/providers/promptRefinement'
import {
  activeAgentMentionAtCursor,
  filterAgentMentions,
  insertAgentMention,
  resolveGroupMessageRecipients,
  type ActiveAgentMention,
  type AgentMentionCandidate
} from '../utils/agentMentions'
import type { GroupAgentContextSnapshot } from '../utils/groupAgentContext'
import { selectPromptRefinementHistory } from '../utils/promptRefinementHistory'
import './GroupChatPanel.css'

interface GroupChatPanelProps {
  groupId: string
  focusedSessionId?: string | null
  onFocusSession?: (sessionId: string | null) => void
  pinnedModels: PinnedModel[]
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  onOpenModelSearch: () => void
  onFocusedSessionContextChange?: (snapshot: GroupAgentContextSnapshot | null) => void
}

function initials(label: string): string {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

export default function GroupChatPanel({
  groupId,
  focusedSessionId = null,
  onFocusSession,
  pinnedModels,
  autoCompactEnabled = true,
  autoCompactThreshold = 0.8,
  onOpenModelSearch,
  onFocusedSessionContextChange
}: GroupChatPanelProps): React.JSX.Element {
  const [detail, setDetail] = useState<CollaborationGroupDetail | null>(null)
  const [text, setText] = useState('')
  const [target, setTarget] = useState('everyone')
  const [sending, setSending] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(
    () => window.matchMedia('(min-width: 1051px)').matches
  )
  const [showRecipients, setShowRecipients] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [error, setError] = useState('')
  const [missionAction, setMissionAction] = useState<'pause' | 'resume' | 'stop' | null>(null)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingGeometry, setEditingGeometry] = useState<MessageEditGeometry | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [activeMention, setActiveMention] = useState<ActiveAgentMention | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const endRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recipientMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mentionMenuId = useId()
  const detailGroupId = detail?.group.id

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.api.collaboration.getGroup(groupId)
    setDetail(next)
  }, [groupId])

  useEffect(() => {
    setDetail(null)
    setError('')
    setText('')
    setTarget('everyone')
    setShowWorkspace(window.matchMedia('(min-width: 1051px)').matches)
    setShowRecipients(false)
    setShowModels(false)
    setEditingMessageId(null)
    setEditingGeometry(null)
    setEditingContent('')
    setActiveMention(null)
    setActiveMentionIndex(0)
    void refresh()
    return window.api.collaboration.onChanged((change) => {
      if (change.groupId === groupId) void refresh()
    })
  }, [groupId, refresh])

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )

  useEffect(() => {
    if (!detailGroupId) return
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }, [detailGroupId])

  useEffect(() => {
    if (!showWorkspace) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && window.matchMedia('(max-width: 1050px)').matches) {
        setShowWorkspace(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showWorkspace])

  useEffect(() => {
    if (!showRecipients && !showModels) return
    const close = (event: MouseEvent): void => {
      const targetNode = event.target as Node
      if (!recipientMenuRef.current?.contains(targetNode)) setShowRecipients(false)
      if (!modelMenuRef.current?.contains(targetNode)) setShowModels(false)
    }
    window.addEventListener('mousedown', close)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowRecipients(false)
        setShowModels(false)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showModels, showRecipients])

  const participants = useMemo(
    () => detail?.participants.filter(({ status }) => status === 'active') || [],
    [detail]
  )
  const participantById = useMemo(
    () => new Map((detail?.participants || []).map((participant) => [participant.id, participant])),
    [detail]
  )
  const channelMessages = useMemo(
    () => projectGroupChannelMessages(detail?.events || [], participants),
    [detail?.events, participants]
  )
  const latestChannelMessage = channelMessages.at(-1)
  const promptRefinementHistory = useMemo(
    () => selectPromptRefinementHistory(channelMessages),
    [channelMessages]
  )
  const channelScrollKey = `${channelMessages.length}:${latestChannelMessage?.id || ''}:${latestChannelMessage?.timestamp || 0}:${latestChannelMessage?.content.length || 0}`
  const { showScrollToBottom, scrollToBottom } = useAutoScroll(
    endRef,
    timelineRef,
    channelMessages,
    'auto',
    `${groupId}:${detailGroupId || 'loading'}:${focusedSessionId || 'channel'}`,
    channelScrollKey
  )
  const mentionCandidates = useMemo(
    () => (activeMention ? filterAgentMentions(participants, activeMention.query) : []),
    [activeMention, participants]
  )
  const mission = detail?.activeMission
  const missionObjective = mission
    ? detail?.events.find(({ id }) => id === mission.objectiveEventId)?.payload.text
    : undefined
  const workingRuns = detail?.participantRuns.filter(({ status }) => status === 'working') || []
  const queuedRuns = detail?.participantRuns.filter(({ status }) => status === 'queued') || []
  const groupIsBusy = workingRuns.length > 0 || queuedRuns.length > 0
  const targetLabel =
    target === 'everyone' ? 'Everyone' : participantById.get(target)?.label || 'Project agent'
  const sessionByParticipantId = useMemo(
    () => new Map((detail?.agentSessions || []).map((session) => [session.participantId, session])),
    [detail?.agentSessions]
  )
  const focusedSession = detail?.agentSessions.find(({ id }) => id === focusedSessionId) || null
  const focusedParticipant = focusedSession
    ? participantById.get(focusedSession.participantId) || null
    : null
  const focusedRun = focusedParticipant
    ? detail?.participantRuns.find(({ participantId }) => participantId === focusedParticipant.id)
    : undefined
  const modelTargets =
    target === 'everyone' ? participants : participants.filter(({ id }) => id === target)
  const targetModelIds = modelTargets
    .map(
      (participant) => pinnedModelForProviderTarget(pinnedModels, participant.providerTarget)?.id
    )
    .filter((id): id is string => Boolean(id))
  const selectedGroupModelId =
    targetModelIds.length === modelTargets.length && new Set(targetModelIds).size === 1
      ? targetModelIds[0]
      : undefined
  const modelLabelOverride = selectedGroupModelId
    ? undefined
    : target === 'everyone'
      ? `${modelTargets.length} agent models`
      : modelTargets[0]?.providerTarget.model || 'Select model'
  const modelChangeBusy = modelTargets.some((participant) =>
    detail?.participantRuns.some(
      (run) => run.participantId === participant.id && ['queued', 'working'].includes(run.status)
    )
  )

  const send = async (
    draft: string,
    targetParticipantIds: string[],
    clearComposer = false
  ): Promise<boolean> => {
    const content = draft.trim()
    if (!content || sending) return false
    if (clearComposer) {
      setText('')
      setActiveMention(null)
      setActiveMentionIndex(0)
    }
    scrollToBottom()
    setSending(true)
    setError('')
    try {
      await window.api.collaboration.sendMessage({
        groupId,
        text: content,
        targetParticipantIds
      })
      await refresh()
      return true
    } catch (reason) {
      if (clearComposer) setText(content)
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSending(false)
    }
  }

  const sendComposerMessage = (): Promise<boolean> => {
    const recipients = resolveGroupMessageRecipients(
      text,
      participants,
      target === 'everyone' ? undefined : target
    )
    return send(text, recipients, true)
  }

  const updateComposerText = (value: string): void => {
    const cursor = textareaRef.current?.selectionStart ?? value.length
    setText(value)
    setActiveMention(activeAgentMentionAtCursor(value, cursor, participants))
    setActiveMentionIndex(0)
  }

  const chooseMention = (candidate: AgentMentionCandidate): void => {
    if (!activeMention) return
    const insertion = insertAgentMention(text, activeMention, candidate)
    setText(insertion.value)
    setActiveMention(null)
    setActiveMentionIndex(0)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(insertion.cursor, insertion.cursor)
    })
  }

  const copyMessage = async (message: Message): Promise<void> => {
    try {
      const result = await window.api.clipboard.writeText(messageTextForClipboard(message))
      if (!result.success) throw new Error(result.error || 'Could not copy message')
      setCopiedMessageId(message.id)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopiedMessageId(null)
        copyTimeoutRef.current = null
      }, 2_000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const beginEdit = (message: Message, event: React.MouseEvent<HTMLButtonElement>): void => {
    const bubble = event.currentTarget
      .closest('.message')
      ?.querySelector<HTMLElement>('.message-bubble')
    const messageElement = event.currentTarget.closest<HTMLElement>('.message')
    if (bubble && messageElement) {
      const bubbleRect = bubble.getBoundingClientRect()
      setEditingGeometry({
        width: bubbleRect.width,
        height: bubbleRect.height,
        viewportTop: messageElement.getBoundingClientRect().top
      })
    }
    setEditingMessageId(message.id)
    setEditingContent(message.content)
  }

  const cancelEdit = (): void => {
    setEditingMessageId(null)
    setEditingGeometry(null)
    setEditingContent('')
  }

  const restartFromMessage = async (
    message: Message,
    content = message.content
  ): Promise<boolean> => {
    const replacement = content.trim()
    if (!replacement || sending) return false
    setSending(true)
    setError('')
    try {
      await window.api.collaboration.rewriteMessage({
        groupId,
        eventId: message.id,
        text: replacement
      })
      await refresh()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSending(false)
    }
  }

  const confirmEdit = async (message: Message): Promise<void> => {
    if (await restartFromMessage(message, editingContent)) cancelEdit()
  }

  const updateMission = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (!mission || missionAction) return
    setMissionAction(action)
    setError('')
    try {
      if (action === 'pause') await window.api.collaboration.pauseMission(mission.id)
      if (action === 'resume') await window.api.collaboration.resumeMission(mission.id)
      if (action === 'stop') await window.api.collaboration.stopMission(mission.id)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMissionAction(null)
    }
  }

  if (!detail) {
    return (
      <section className="group-chat-panel group-chat-loading">
        <LoaderCircle size={20} className="spin" />
      </section>
    )
  }

  if (focusedSession && focusedParticipant) {
    return (
      <GroupAgentConversation
        detail={detail}
        session={focusedSession}
        participant={focusedParticipant}
        pinnedModels={pinnedModels}
        onOpenModelSearch={onOpenModelSearch}
        onBackToGroup={() => onFocusSession?.(null)}
        onContextChange={onFocusedSessionContextChange}
      />
    )
  }

  return (
    <section
      className={`group-chat-panel ${showWorkspace && !focusedSession ? 'has-agent-rail' : ''}`}
    >
      <header className="group-chat-header">
        <div className="group-chat-heading">
          <div className="group-chat-symbol">
            <Users size={17} />
          </div>
          <div className="group-chat-title-wrap">
            <h1>{detail.group.title}</h1>
            <span>{participants.map(({ projectName }) => projectName).join(' + ')}</span>
          </div>
        </div>
        <button
          type="button"
          className="group-workspace-button"
          onClick={() =>
            focusedSession ? onFocusSession?.(null) : setShowWorkspace((value) => !value)
          }
          aria-expanded={showWorkspace}
          aria-controls="group-workspace-panel"
          title={showWorkspace ? 'Hide agent sessions' : 'Show agent sessions'}
        >
          <span className="group-avatar-stack">
            {participants.map((participant) => (
              <span key={participant.id} className="group-mini-avatar">
                {initials(participant.projectName)}
              </span>
            ))}
          </span>
          <span>{focusedSession ? 'Agent session' : 'Agents'}</span>
          <PanelRight size={14} />
        </button>
      </header>

      {mission && ['running', 'queued', 'paused'].includes(mission.status) && (
        <div className="group-mission-strip">
          <span className={`group-mission-dot ${mission.status}`} />
          <span className="group-mission-label">
            {mission.status === 'paused'
              ? 'Agents paused'
              : workingRuns.length
                ? `${workingRuns.length} agent${workingRuns.length === 1 ? '' : 's'} working independently`
                : queuedRuns.length
                  ? 'Starting agents'
                  : 'Agents are up to date'}
          </span>
          {mission.error && (
            <span className="group-mission-error" title={mission.error}>
              {mission.error}
            </span>
          )}
          <span className="group-mission-actions">
            {mission.status === 'paused' ? (
              <button
                type="button"
                onClick={() => void updateMission('resume')}
                title="Resume mission"
                disabled={missionAction !== null}
              >
                <Play size={13} /> Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void updateMission('pause')}
                title="Pause mission"
                disabled={missionAction !== null}
              >
                <Pause size={13} /> Pause
              </button>
            )}
            <button
              type="button"
              className="danger"
              onClick={() => void updateMission('stop')}
              title="Stop mission"
              disabled={missionAction !== null}
            >
              <CircleStop size={13} /> Stop
            </button>
          </span>
        </div>
      )}

      <div className="group-chat-content">
        {focusedSession && focusedParticipant ? (
          <div className="group-focused-session">
            <GroupWorkspacePanel
              open
              expanded
              participants={[focusedParticipant]}
              allParticipants={detail.participants}
              agentSession={focusedSession}
              pinnedModels={pinnedModels}
              autoCompactEnabled={autoCompactEnabled}
              autoCompactThreshold={autoCompactThreshold}
              participantRuns={focusedRun ? [focusedRun] : []}
              mission={mission || null}
              events={detail.events}
              historyVersion={
                detail.events.filter(
                  (event) =>
                    event.actorParticipantId === focusedParticipant.id &&
                    event.payload.metadata?.checkpointHash
                ).length
              }
              onClose={() => onFocusSession?.(null)}
            />
          </div>
        ) : (
          <>
            <div className="group-timeline" ref={timelineRef}>
              {channelMessages.length === 0 && (
                <div className="empty-state group-intro">
                  <span className="group-intro-icon">
                    <Users size={20} />
                  </span>
                  <h2>Start the conversation</h2>
                  <p>Message everyone or choose one project agent below.</p>
                </div>
              )}

              {channelMessages.map((message, index) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  index={index}
                  isLoading={false}
                  expandedThinking={expandedThinking}
                  editingMessageId={editingMessageId}
                  editingGeometry={editingGeometry}
                  editingContent={editingContent}
                  copiedMessageId={copiedMessageId}
                  onToggleThinking={(id) =>
                    setExpandedThinking((current) => {
                      const next = new Set(current)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }
                  onHandleArtifactResult={() => undefined}
                  onEditMessage={beginEdit}
                  onCancelEditMessage={cancelEdit}
                  onConfirmEditMessage={(targetMessage) => void confirmEdit(targetMessage)}
                  onCopyMessage={(targetMessage) => void copyMessage(targetMessage)}
                  onRetryMessage={(targetMessage) => void restartFromMessage(targetMessage)}
                  onSetEditingContent={setEditingContent}
                  onApproveToolLimitDecision={(interactionId) =>
                    void window.api.agentRuns.resolveInteraction({
                      interactionId,
                      response: { approved: true }
                    })
                  }
                  onDenyToolLimitDecision={(interactionId) =>
                    void window.api.agentRuns.resolveInteraction({
                      interactionId,
                      response: { approved: false }
                    })
                  }
                  onResolveAgentInteraction={(interactionId, response, cancelled) =>
                    void window.api.agentRuns.resolveInteraction({
                      interactionId,
                      response,
                      cancelled
                    })
                  }
                  editActionTitle="Edit and restart from here"
                  confirmEditActionTitle="Save and restart from here"
                  retryActionTitle="Restart from here"
                />
              ))}
              <div ref={endRef} />
            </div>

            {showWorkspace && (
              <button
                type="button"
                className="group-workspace-scrim"
                onClick={() => setShowWorkspace(false)}
                aria-label="Close group workspace"
              />
            )}
            {showWorkspace && (
              <aside
                id="group-workspace-panel"
                className="group-agent-rail"
                aria-label="Agent sessions"
              >
                {participants.map((participant) => {
                  const session = sessionByParticipantId.get(participant.id)
                  if (!session) return null
                  const run = detail.participantRuns.find(
                    ({ participantId }) => participantId === participant.id
                  )
                  return (
                    <GroupWorkspacePanel
                      key={session.id}
                      open
                      participants={[participant]}
                      allParticipants={detail.participants}
                      agentSession={session}
                      pinnedModels={pinnedModels}
                      autoCompactEnabled={autoCompactEnabled}
                      autoCompactThreshold={autoCompactThreshold}
                      participantRuns={run ? [run] : []}
                      mission={mission || null}
                      events={detail.events}
                      historyVersion={
                        detail.events.filter(
                          (event) =>
                            event.actorParticipantId === participant.id &&
                            event.payload.metadata?.checkpointHash
                        ).length
                      }
                      onClose={() => setShowWorkspace(false)}
                      onOpenFull={() => onFocusSession?.(session.id)}
                    />
                  )
                })}
              </aside>
            )}
          </>
        )}
      </div>

      {!focusedSession && (
        <footer className="group-composer-wrap">
          {error && <div className="group-composer-error">{error}</div>}
          <ChatComposer
            className="group-input-area"
            value={text}
            inputRef={textareaRef}
            placeholder={`Message ${target === 'everyone' ? detail.group.title : targetLabel}`}
            promptRefinement={
              modelTargets[0]
                ? {
                    model: promptRefinementModelForTarget(modelTargets[0].providerTarget),
                    context: {
                      surface: 'group',
                      groupTitle: detail.group.title,
                      recipientLabels: modelTargets.map(({ label }) => label),
                      activeObjective: missionObjective,
                      ...promptRefinementHistory
                    }
                  }
                : undefined
            }
            onChange={updateComposerText}
            onKeyDown={(event) => {
              if (activeMention && !event.nativeEvent.isComposing) {
                if (event.key === 'ArrowDown' && mentionCandidates.length) {
                  event.preventDefault()
                  setActiveMentionIndex((current) => (current + 1) % mentionCandidates.length)
                  return
                }
                if (event.key === 'ArrowUp' && mentionCandidates.length) {
                  event.preventDefault()
                  setActiveMentionIndex(
                    (current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length
                  )
                  return
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && mentionCandidates.length) {
                  event.preventDefault()
                  chooseMention(mentionCandidates[activeMentionIndex] || mentionCandidates[0])
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setActiveMention(null)
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void sendComposerMessage()
              }
            }}
            onSend={() => void sendComposerMessage()}
            floatingAccessory={
              <ScrollToBottomButton
                visible={showScrollToBottom && !activeMention}
                onClick={scrollToBottom}
              />
            }
            popover={
              activeMention ? (
                <AgentMentionMenu
                  id={mentionMenuId}
                  candidates={mentionCandidates}
                  activeIndex={activeMentionIndex}
                  onActiveIndexChange={setActiveMentionIndex}
                  onSelect={chooseMention}
                />
              ) : undefined
            }
            inputAriaControls={activeMention ? mentionMenuId : undefined}
            inputAriaExpanded={Boolean(activeMention)}
            inputAriaActiveDescendant={
              activeMention && mentionCandidates[activeMentionIndex]
                ? `${mentionMenuId}-option-${mentionCandidates[activeMentionIndex].id}`
                : undefined
            }
            sendDisabled={!text.trim() || sending}
            sendTitle={sending ? 'Sending message…' : 'Send message'}
            toolbarLeft={
              <>
                <div className="features-menu-container" ref={recipientMenuRef}>
                  <button
                    type="button"
                    className={`input-plus-button ${showRecipients ? 'menu-open' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setShowRecipients((value) => !value)
                    }}
                    aria-label="Message recipients"
                    title="Choose who receives this message"
                    aria-expanded={showRecipients}
                  >
                    <Plus size={18} strokeWidth={1.8} />
                  </button>
                  {showRecipients && (
                    <div className="features-menu group-recipient-menu">
                      <div className="group-menu-heading">Send to</div>
                      <button
                        type="button"
                        className="features-menu-item"
                        onClick={() => {
                          setTarget('everyone')
                          setShowRecipients(false)
                          textareaRef.current?.focus()
                        }}
                      >
                        <span className="features-menu-item-content">
                          <span className="features-menu-item-label">Everyone</span>
                          <span className="features-menu-item-description">
                            Notify every project agent
                          </span>
                        </span>
                        {target === 'everyone' && <Check size={15} />}
                      </button>
                      {participants.map((participant) => (
                        <button
                          type="button"
                          className="features-menu-item"
                          key={participant.id}
                          onClick={() => {
                            setTarget(participant.id)
                            setShowRecipients(false)
                            textareaRef.current?.focus()
                          }}
                        >
                          <span className="features-menu-item-content">
                            <span className="features-menu-item-label">{participant.label}</span>
                            <span className="features-menu-item-description">
                              {participant.projectName}
                            </span>
                          </span>
                          {target === participant.id && <Check size={15} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {workingRuns.length > 0 && (
                  <span className="composer-status group-working-status">
                    <LoaderCircle size={13} className="spin" />
                    {workingRuns.length} working
                  </span>
                )}
              </>
            }
            toolbarRight={
              <>
                <ChatModelPicker
                  selectedModelId={selectedGroupModelId}
                  models={pinnedModels.filter(({ supportsTools }) => supportsTools !== false)}
                  isOpen={showModels}
                  containerRef={modelMenuRef}
                  labelOverride={modelLabelOverride}
                  disabled={modelChangeBusy}
                  titleOverride={
                    modelChangeBusy
                      ? 'Pause the addressed agent before changing its model'
                      : target === 'everyone'
                        ? 'Change the model for every agent'
                        : `Change ${targetLabel}'s model`
                  }
                  onToggle={() => setShowModels((value) => !value)}
                  onModelChange={async (modelId) => {
                    const model = pinnedModels.find(({ id }) => id === modelId)
                    if (!model) return
                    setError('')
                    try {
                      await window.api.collaboration.updateParticipants({
                        groupId,
                        participantIds: modelTargets.map(({ id }) => id),
                        providerTarget: providerTargetForPinnedModel(model)
                      })
                      await refresh()
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : String(reason))
                    }
                  }}
                  onManageModels={onOpenModelSearch}
                />
                {mission && groupIsBusy && (
                  <button
                    type="button"
                    className={`stop-button ${missionAction === 'stop' ? 'is-stopping' : ''}`}
                    onClick={() => void updateMission('stop')}
                    disabled={missionAction !== null}
                    title={missionAction === 'stop' ? 'Stopping all agents…' : 'Stop all agents'}
                    aria-label="Stop all agents"
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                )}
              </>
            }
          />
        </footer>
      )}
    </section>
  )
}
