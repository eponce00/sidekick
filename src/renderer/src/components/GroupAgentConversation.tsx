import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderOpen, MessageCircle, Plus, Square, StickyNote } from 'lucide-react'
import type {
  CollaborationAgentSession,
  CollaborationAgentSessionMessage,
  CollaborationGroupDetail,
  CollaborationParticipant
} from '../../../shared/collaboration'
import type { Message, MessageEditGeometry } from '../types/chat.types'
import type { PinnedModel } from '../types/models.types'
import { projectGroupAgentConversation } from '../utils/groupAgentConversation'
import { groupAgentContextTokens, type GroupAgentContextSnapshot } from '../utils/groupAgentContext'
import { messageTextForClipboard } from '../utils/messageClipboard'
import {
  createFallbackConversationTitle,
  generateConversationTitle
} from '../utils/chatPanelHelpers'
import { providerDefinition } from '../../../shared/providerRegistry'
import { createConversationTitleMessages } from '../services/prompts'
import { useAutoFocus } from '../hooks/useAutoFocus'
import { useAutoScroll } from '../hooks/useAutoScroll'
import ActivityPanel from './ActivityPanel'
import { ChatComposer } from './ChatComposer'
import { MessageItem } from './MessageItem'
import { pinnedModelForProviderTarget, providerTargetForPinnedModel } from '../utils/providerTarget'
import { ChatModelPicker } from './ChatModelPicker'
import { WorkspaceMemoryModal } from './WorkspaceMemoryModal'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { promptRefinementModelForTarget } from '../services/providers/promptRefinement'
import { selectPromptRefinementHistory } from '../utils/promptRefinementHistory'
import './GroupAgentConversation.css'

interface GroupAgentConversationProps {
  detail: CollaborationGroupDetail
  session: CollaborationAgentSession
  participant: CollaborationParticipant
  pinnedModels: PinnedModel[]
  onOpenModelSearch: () => void
  onBackToGroup: () => void
  onContextChange?: (snapshot: GroupAgentContextSnapshot | null) => void
}

export default function GroupAgentConversation({
  detail,
  session,
  participant,
  pinnedModels,
  onOpenModelSearch,
  onBackToGroup,
  onContextChange
}: GroupAgentConversationProps): React.JSX.Element {
  const [sessionMessages, setSessionMessages] = useState<CollaborationAgentSessionMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingGeometry, setEditingGeometry] = useState<MessageEditGeometry | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [showFeatures, setShowFeatures] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [workspaceMemory, setWorkspaceMemory] = useState('')
  const [instructionStatus, setInstructionStatus] = useState<{
    sources: string[]
    truncated: boolean
    error?: string
  }>({ sources: [], truncated: false })
  const [isActivityPanelPinned, setIsActivityPanelPinned] = useState(() => {
    const stored = window.localStorage.getItem('activityPanelPinned')
    return stored === null ? window.innerWidth >= 1100 : stored === 'true'
  })
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleAttemptedRef = useRef<Set<string>>(new Set())
  const featuresRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const latestEventSeq = detail.events.at(-1)?.seq

  useEffect(() => {
    let cancelled = false
    window.api.collaboration.listAgentSessionMessages(session.id).then((messages) => {
      if (!cancelled) setSessionMessages(messages)
    })
    return () => {
      cancelled = true
    }
  }, [latestEventSeq, session.id, session.updatedAt])

  useEffect(() => {
    void window.api.memory.get(participant.projectFolder).then((result) => {
      if (result.ok) setWorkspaceMemory(result.content)
    })
    void window.api.workspace.getRules(participant.projectFolder).then((result) => {
      setInstructionStatus(
        result.ok
          ? { sources: result.sources, truncated: result.truncated }
          : { sources: [], truncated: false, error: result.error || 'Could not load instructions' }
      )
    })
  }, [participant.projectFolder])

  useEffect(() => {
    if (!showFeatures && !showModels) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!featuresRef.current?.contains(target)) setShowFeatures(false)
      if (!modelRef.current?.contains(target)) setShowModels(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [showFeatures, showModels])

  useEffect(() => {
    const firstUserMessage = detail.events.find(
      (event) => event.kind === 'user_message' && event.payload.text?.trim()
    )?.payload.text
    const firstAssistantMessage = sessionMessages.find(
      (message) => message.kind === 'assistant' && message.content.trim()
    )?.content
    if (!firstUserMessage || !firstAssistantMessage) return
    const fallback = createFallbackConversationTitle(firstUserMessage)
    if (session.title !== 'New Conversation' && session.title !== fallback) return
    if (titleAttemptedRef.current.has(session.id)) return
    titleAttemptedRef.current.add(session.id)
    const target = participant.providerTarget
    void generateConversationTitle(
      {
        provider: providerDefinition(target.providerKind).transport,
        providerKind: target.providerKind,
        providerInstanceId: target.providerInstanceId,
        model: target.model,
        contextLength: target.contextLength || 32_768,
        fallbackTitle: firstUserMessage,
        retries: 0,
        onUpdateTitle: async (id, title) => {
          await window.api.collaboration.updateAgentSession(id, { title })
        }
      },
      session.id,
      createConversationTitleMessages(firstUserMessage, firstAssistantMessage.slice(0, 300))
    )
  }, [detail.events, participant.providerTarget, session.id, session.title, sessionMessages])

  useEffect(() => {
    window.localStorage.setItem('activityPanelPinned', String(isActivityPanelPinned))
  }, [isActivityPanelPinned])

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )

  const projection = useMemo(
    () =>
      projectGroupAgentConversation({
        participant,
        participants: detail.participants,
        events: detail.events,
        sessionMessages
      }),
    [detail.events, detail.participants, participant, sessionMessages]
  )
  const participantRun = detail.participantRuns.find(
    ({ participantId }) => participantId === participant.id
  )
  const isBusy = Boolean(participantRun && ['queued', 'working'].includes(participantRun.status))
  const selectedPinnedModel = pinnedModelForProviderTarget(pinnedModels, participant.providerTarget)
  const contextSnapshot = useMemo<GroupAgentContextSnapshot>(
    () => ({
      sessionId: session.id,
      currentTokens: groupAgentContextTokens(sessionMessages),
      maxTokens:
        participant.providerTarget.contextLength || selectedPinnedModel?.contextLength || 0,
      selectedModel: selectedPinnedModel?.id || participant.providerTarget.model,
      model: selectedPinnedModel
    }),
    [participant.providerTarget, selectedPinnedModel, session.id, sessionMessages]
  )

  useEffect(() => {
    onContextChange?.(contextSnapshot)
  }, [contextSnapshot, onContextChange])

  useEffect(
    () => () => {
      onContextChange?.(null)
    },
    [onContextChange]
  )
  const visibleMessages = useMemo(() => {
    if (!isBusy) return projection.messages
    const last = projection.messages.at(-1)
    const hasRunningTool = last?.segments?.some(
      (segment) => segment.type === 'tool' && segment.tool?.status === 'running'
    )
    if (hasRunningTool) return projection.messages
    return [
      ...projection.messages,
      {
        id: `working-${participantRun?.missionId || session.id}`,
        role: 'agent' as const,
        content: '',
        timestamp: participantRun?.startedAt ?? participantRun?.updatedAt ?? Date.now()
      }
    ]
  }, [isBusy, participantRun, projection.messages, session.id])
  const promptRefinementHistory = useMemo(
    () => selectPromptRefinementHistory(projection.messages),
    [projection.messages]
  )
  const missionObjective = detail.activeMission
    ? detail.events.find(({ id }) => id === detail.activeMission?.objectiveEventId)?.payload.text
    : undefined

  const { showScrollToBottom, scrollToBottom } = useAutoScroll(
    messagesEndRef,
    messagesContainerRef,
    visibleMessages,
    'smooth',
    session.id
  )
  useAutoFocus(inputRef, sending, editingMessageId !== null, session.id)

  const send = async (content = input): Promise<boolean> => {
    const text = content.trim()
    if (!text || sending) return false
    scrollToBottom()
    setSending(true)
    setError('')
    if (content === input) setInput('')
    try {
      await window.api.collaboration.sendMessage({
        groupId: detail.group.id,
        text,
        targetParticipantIds: [participant.id]
      })
      return true
    } catch (reason) {
      if (content === input) setInput(text)
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSending(false)
    }
  }

  const stopGeneration = async (): Promise<void> => {
    if (!participantRun || !isBusy || stopping) return
    setStopping(true)
    setError('')
    try {
      await window.api.collaboration.stopParticipant(participantRun.missionId, participant.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStopping(false)
    }
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
    const text = content.trim()
    if (!text || sending) return false
    setSending(true)
    setError('')
    try {
      await window.api.collaboration.rewriteMessage({
        groupId: detail.group.id,
        eventId: message.id,
        text
      })
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

  const historyVersion = sessionMessages.filter(
    ({ metadata }) => typeof metadata.checkpointHash === 'string'
  ).length

  return (
    <div className="group-agent-conversation-shell">
      <div className="chat-panel group-agent-conversation-chat">
        <div className="messages-container" ref={messagesContainerRef}>
          {visibleMessages.length ? (
            visibleMessages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                index={index}
                isLoading={
                  isBusy && index === visibleMessages.length - 1 && message.role === 'agent'
                }
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
                onConfirmEditMessage={(target) => void confirmEdit(target)}
                onCopyMessage={(target) => void copyMessage(target)}
                onRetryMessage={(target) => void restartFromMessage(target)}
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
                workspaceFolder={participant.projectFolder}
                editActionTitle="Edit and restart from here"
                confirmEditActionTitle="Save and restart from here"
                retryActionTitle="Restart from here"
              />
            ))
          ) : (
            <div className="empty-state">
              <h2>{session.title}</h2>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {error && <div className="group-agent-conversation-error">{error}</div>}
        <ChatComposer
          value={input}
          inputRef={inputRef}
          placeholder={`Message ${session.title}`}
          disabled={sending}
          promptRefinement={{
            model: promptRefinementModelForTarget(participant.providerTarget),
            context: {
              surface: 'group-agent',
              projectName: participant.projectName,
              groupTitle: detail.group.title,
              recipientLabels: [participant.label],
              activeObjective: missionObjective,
              ...promptRefinementHistory
            }
          }}
          onChange={setInput}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          onSend={() => void send()}
          floatingAccessory={
            <ScrollToBottomButton visible={showScrollToBottom} onClick={scrollToBottom} />
          }
          sendDisabled={!input.trim() || sending}
          sendTitle={sending ? 'Sending message…' : 'Send message'}
          toolbarLeft={
            <div className="features-menu-container" ref={featuresRef}>
              <button
                type="button"
                className={`input-plus-button ${showFeatures ? 'menu-open' : ''}`}
                onClick={() => setShowFeatures((current) => !current)}
                title="Project and group options"
                aria-label="Project and group options"
                aria-expanded={showFeatures}
              >
                <Plus size={18} strokeWidth={1.8} />
              </button>
              {showFeatures && (
                <div className="features-menu">
                  <button type="button" className="features-menu-item" onClick={onBackToGroup}>
                    <span className="features-menu-item-icon">
                      <MessageCircle size={16} />
                    </span>
                    <span className="features-menu-item-content">
                      <span className="features-menu-item-label">Group conversation</span>
                      <span className="features-menu-item-description">
                        Return to the shared channel
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="features-menu-item"
                    onClick={() => {
                      void window.api.workspace.openFolder(
                        participant.projectFolder,
                        participant.projectFolder
                      )
                      setShowFeatures(false)
                    }}
                  >
                    <span className="features-menu-item-icon">
                      <FolderOpen size={16} />
                    </span>
                    <span className="features-menu-item-content">
                      <span className="features-menu-item-label">Open project folder</span>
                      <span className="features-menu-item-description">
                        {participant.projectName}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="features-menu-item"
                    onClick={() => {
                      setShowMemory(true)
                      setShowFeatures(false)
                    }}
                  >
                    <span className="features-menu-item-icon">
                      <StickyNote size={16} />
                    </span>
                    <span className="features-menu-item-content">
                      <span className="features-menu-item-label">Shared project notes</span>
                      <span className="features-menu-item-description">
                        Context included in every chat for this project
                      </span>
                    </span>
                  </button>
                  <div
                    className={`features-menu-item features-menu-info ${instructionStatus.error ? 'is-error' : ''}`}
                    title={
                      instructionStatus.sources.join('\n') ||
                      instructionStatus.error ||
                      'No project instruction files found'
                    }
                  >
                    <span className="features-menu-item-icon">
                      <FileText size={16} />
                    </span>
                    <span className="features-menu-item-content">
                      <span className="features-menu-item-label">Instruction files (AGENTS.md)</span>
                      <span className="features-menu-item-description">
                        {instructionStatus.error
                          ? 'Could not load safely'
                          : instructionStatus.sources.length
                            ? `${instructionStatus.sources.length} file${instructionStatus.sources.length === 1 ? '' : 's'} loaded automatically${instructionStatus.truncated ? ' · truncated' : ''}`
                            : 'No AGENTS.md or SideKick rules loaded'}
                      </span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          }
          toolbarRight={
            <>
              <ChatModelPicker
                selectedModelId={selectedPinnedModel?.id}
                models={pinnedModels}
                isOpen={showModels}
                containerRef={modelRef}
                labelOverride={selectedPinnedModel ? undefined : participant.providerTarget.model}
                disabled={isBusy}
                titleOverride={isBusy ? 'Stop this agent before changing its model' : undefined}
                onToggle={() => setShowModels((current) => !current)}
                onModelChange={async (modelId) => {
                  const model = pinnedModels.find(({ id }) => id === modelId)
                  if (!model) return
                  setError('')
                  try {
                    await window.api.collaboration.updateParticipant(participant.id, {
                      providerTarget: providerTargetForPinnedModel(model)
                    })
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason))
                  }
                }}
                onManageModels={onOpenModelSearch}
              />
              {isBusy && (
                <button
                  type="button"
                  className={`stop-button ${stopping ? 'is-stopping' : ''}`}
                  onClick={() => void stopGeneration()}
                  disabled={stopping}
                  title={stopping ? 'Stopping…' : `Stop ${participant.label}`}
                  aria-label={`Stop ${participant.label}`}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )}
            </>
          }
        />
      </div>

      <ActivityPanel
        isPinned={isActivityPanelPinned}
        onTogglePin={() => setIsActivityPanelPinned((current) => !current)}
        focusChainTodos={[]}
        workspaceFolder={participant.projectFolder}
        historyWorkspaceFolder={participant.projectFolder}
        checkpointVersion={historyVersion}
        titleModel={selectedPinnedModel}
        isAgentBusy={isBusy}
      />
      <WorkspaceMemoryModal
        isOpen={showMemory}
        workspaceFolder={participant.projectFolder}
        initialContent={workspaceMemory}
        onClose={() => setShowMemory(false)}
        onSaved={setWorkspaceMemory}
      />
    </div>
  )
}
