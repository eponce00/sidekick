import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, ArrowUpRight, X } from 'lucide-react'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { endDictation } from '../services/voice/dictationControl'
import { useAutoFocus } from '../hooks/useAutoFocus'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { useChatFolder } from '../hooks/useChatFolder'
import {
  RunAlreadyActiveError,
  useConversationRun,
  type DuringRunSubmission,
  type PendingRunMessageItem,
  type SendConversationMessageOptions
} from '../hooks/useConversationRun'
import { useConversationMessages } from '../hooks/useConversationMessages'
import { useConversationActions } from '../hooks/useConversationActions'
import { loadTerminalSessions } from '../utils/terminalSessionStore'
import { useConversationGoal } from '../hooks/useConversationGoal'
import { MessageItem } from './MessageItem'
import { memberName, memberState, useSessionFamily } from '../hooks/useSessionFamily'
import { sessionTimeline, workerBriefIds, type SessionTimelineRow } from '../utils/sessionTimeline'
import { latestRunTodos } from '../utils/runTodos'
import { FamilyStrip, ReceivedMessagesRow, StartedChatsRow } from './ManagerChatRows'
import { SessionTodoList } from './SessionTodoList'
import { BriefCard, SessionMessageRow, WorkerChatHeader } from './WorkerChatParts'
import { SidekickPeek } from './SidekickPeek'
import { workerWorkplace } from '../utils/sessionLabels'
import { WorkerChatContext } from './sessionChatContext'
import {
  reasoningOptions,
  resolveReasoningLevel,
  type ReasoningLevel,
  type ReasoningModel,
  type ReasoningSettings
} from '../../../shared/reasoning'
import type { ProviderKind } from '../../../shared/providerRegistry'
import { providerImageProfile } from '../../../shared/imagePreparation'
import { ChatInput } from './ChatInput'
import ConfirmDialog from './ConfirmDialog'
import { WorkspaceMemoryModal } from './WorkspaceMemoryModal'
import type { TodoItem } from '../../../shared/types'
import type { PermissionMode } from '../../../shared/permissions'
import type { ConversationTitleSource } from '../../../shared/conversationTitles'
import { modelNameFromId } from '../../../shared/conversationModels'
import type { ConversationRunMode } from '../../../shared/agentRunApi'
import type { Message } from '../types/chat.types'
import type { PinnedModel } from '../types/models.types'
import {
  getProviderFromModel,
  stripModelPrefix,
  FAST_MODEL_CONTEXT_LIMIT
} from '../utils/chatHelpers'
import {
  createFallbackConversationTitle,
  generateConversationTitle,
  getQueuedMessageIdForEmptySubmit,
  isPlaceholderConversationTitle
} from '../utils/chatPanelHelpers'
import type { WelcomeSuggestion } from '../utils/welcomeSuggestions'
import { selectPromptRefinementHistory } from '../utils/promptRefinementHistory'
import { buildPromptHistoryEntries } from '../utils/composerPromptHistory'
import {
  isCompletionToAnnounce,
  markCompletionAnnounced,
  observeGoal
} from '../utils/goalCompletionNotice'
import { createConversationTitleMessages } from '../services/prompts'
import { MAX_MESSAGE_IMAGES, type MessageImageAttachment } from '../../../shared/messageImages'
import {
  MAX_MESSAGE_CONTEXT_ATTACHMENTS,
  pastedTextBudget,
  createPastedTextAttachment,
  createReviewCommentAttachment,
  isBrowserAnnotationAttachment,
  isPastedTextAttachment,
  isProjectContextAttachment,
  isReviewCommentAttachment,
  type BrowserAnnotationAttachment,
  type MessageContextAttachment,
  type ReviewCommentInput
} from '../../../shared/messageContextAttachments'
import { fileToMessageImage } from '../utils/messageImageAttachments'
import { loadComposerDraft } from '../services/composerDrafts'
import { composerDraftKey, useComposerDraft } from '../hooks/useComposerDraft'
import { ReviewCommentSinkContext } from '../hooks/useReviewCommentSink'
import { SubAgentNavigation, type SubAgentTarget } from './subAgentNavigation'
import { SubAgentView } from './SubAgentView'
import { ProjectChoiceChip, WorkspaceBar, WorktreeChip } from './WorkspaceBar'
import { WorkspaceBusyDialog, type WorkspaceBusyChoice } from './WorkspaceBusyDialog'
import { rememberWorkInChoice, storedWorkInChoice } from '../hooks/useManagedWorktrees'
import type { ComposerDraft } from '../services/composerDrafts'
import {
  workspaceBusyDisplayMessage,
  type ManagedWorktreeSummary,
  type WorkInChoice,
  type WorkspaceOccupant
} from '../../../shared/worktrees'
import '../styles/codeTheme.css'
import 'katex/dist/katex.min.css'
import './ChatPanel.css'
import { flyIntoComposer } from '../utils/flyIntoComposer'
import { dissolveMessages, easeInReply, liftSendArrow, riseIntoChat } from '../utils/messageMotion'

export type { PinnedModel }

interface ChatPanelProps {
  pinnedModels: PinnedModel[]
  onOpenModelSearch: () => void
  conversationId: string | null
  conversationTitle: string | null
  welcomeSuggestions: readonly WelcomeSuggestion[]
  /** The context meter, drawn among the composer's run controls. */
  contextMeter?: React.ReactNode
  workspaceFolder: string | null
  projectName: string | null
  projectId?: string | null
  /** Set when the chat's project is one of SideKick's worktrees. */
  worktree?: ManagedWorktreeSummary | null
  /** Moves a chat that has not sent anything yet into its own new worktree. */
  onStartInWorktree?: (conversationId: string, options: { baseRef?: string }) => Promise<void>
  /** Forks a chat with history into a new worktree, carrying the unsent message along. */
  onForkIntoWorktree?: (conversationId: string, draft: ComposerDraft) => Promise<void>
  onManageWorktrees?: () => void
  /** Projects a chat outside any project can move into before its first message. */
  projectChoices?: ReadonlyArray<{ id: string; name: string }>
  onChooseProject?: (projectId: string) => Promise<void>
  onOpenProject: () => Promise<void> | void
  onUpdateConversationTitle: (
    id: string,
    title: string,
    source?: ConversationTitleSource
  ) => Promise<void> | void
  onConversationTitleApplied: (id: string, title: string) => void
  onConversationCreated: (id: string, title: string) => void
  onForkConversation: (messageId: string) => void
  selectedModel: string
  planningModelId?: string
  onModelChange: (modelId: string) => void
  onTokenCountUpdate?: (currentTokens: number, maxTokens: number) => void
  onConversationCostUpdate?: (totalCost: number) => void
  onFocusChainUpdate: (conversationId: string, todos: TodoItem[]) => void
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  focusChainEnabled?: boolean
  toolCallLimit?: number
  commandPermissionMode?: PermissionMode
  /** Changes the permission mode every chat uses, from the composer. */
  onPermissionModeChange?: (mode: PermissionMode) => void
  userLocation?: { city?: string; country?: string; timezone?: string }
  onResponseComplete?: (message: string) => void
  /** Changes when the user asked to see this conversation's newest reply. */
  focusReplyAt?: number
  onBusyStateChange?: (conversationId: string | null, busy: boolean) => void
  fastModelName?: string
  /** Chosen reasoning levels, and the older switches that seed a model's first level. */
  reasoningSettings?: ReasoningSettings
  onReasoningLevelChange: (modelId: string, level: ReasoningLevel) => void
  /** Opens another chat, as when a worker's chip or its manager's breadcrumb is clicked. */
  onOpenConversation?: (conversationId: string) => void
}

/** What a new conversation is named from: the typed text, else what was pasted or attached. */
function conversationTitlePrompt(message: Message): string {
  const pasted = message.attachments?.find(isPastedTextAttachment)
  const review = message.attachments?.find(isReviewCommentAttachment)
  const mark = message.attachments?.find(isBrowserAnnotationAttachment)
  return (
    message.content ||
    pasted?.content.slice(0, 1_000) ||
    review?.comment ||
    mark?.note ||
    message.images?.[0]?.name ||
    'Image conversation'
  )
}

/** What the chat holds: the prompt sent, and the reply, estimated at about four characters a token
 *  while it streams and its count is not known yet. */
function contextTokens(usage: NonNullable<Message['tokenUsage']>): number {
  return (
    usage.promptTokens +
    (usage.completionTokens || Math.round((usage.streaming?.characters ?? 0) / 4))
  )
}

function ChatPanel({
  pinnedModels,
  onOpenModelSearch,
  conversationId,
  conversationTitle,
  welcomeSuggestions,
  contextMeter,
  workspaceFolder,
  projectName,
  projectId = null,
  worktree = null,
  onStartInWorktree,
  onForkIntoWorktree,
  onManageWorktrees,
  projectChoices,
  onChooseProject,
  onOpenProject,
  onUpdateConversationTitle,
  onConversationTitleApplied,
  onConversationCreated,
  onForkConversation,
  selectedModel,
  planningModelId,
  onModelChange,
  onTokenCountUpdate,
  onConversationCostUpdate,
  onFocusChainUpdate,
  commandPermissionMode = 'full-access',
  onPermissionModeChange,
  userLocation,
  onResponseComplete,
  focusReplyAt,
  onBusyStateChange,
  fastModelName,
  reasoningSettings = {},
  onReasoningLevelChange,
  onOpenConversation
}: ChatPanelProps): React.JSX.Element {
  const { messages, setMessages, messagesRef, skipNextLoadRef } = useConversationMessages({
    conversationId,
    onCostUpdate: onConversationCostUpdate
  })
  const selectedPinnedModel = pinnedModels.find((model) => model.id === selectedModel)
  // This chat's model was removed or turned off. The chat asks for another rather than quietly
  // running on a different one.
  const unavailableModelName =
    selectedModel && !selectedPinnedModel ? modelNameFromId(selectedModel) : null
  // Read as each reply starts, so a message queued under a running reply goes to the model chosen
  // since, not the one the running reply started with.
  const chatModelRef = useRef({ id: selectedModel, model: selectedPinnedModel })
  chatModelRef.current = { id: selectedModel, model: selectedPinnedModel }
  const selectedContextLength = selectedPinnedModel?.contextLength ?? 32_768
  const tokenCountUpdateRef = useRef(onTokenCountUpdate)
  tokenCountUpdateRef.current = onTokenCountUpdate
  // One handler for every message. A fresh closure per message defeated the
  // message list's memoization, so each keystroke re-rendered the whole
  // conversation: markdown re-parsed and links remounted as the user typed.
  const forkConversationRef = useRef(onForkConversation)
  forkConversationRef.current = onForkConversation
  const forkMessage = useCallback((messageId: string) => forkConversationRef.current(messageId), [])

  // Where the chat works. A project chat chooses before its first message; afterwards a run that
  // would join a folder another agent is writing in asks first.
  const [workIn, setWorkIn] = useState<WorkInChoice>(storedWorkInChoice)
  // A folder without Git keeps the remembered choice but works in the folder.
  const [worktreesAvailable, setWorktreesAvailable] = useState(true)
  const [worktreeBase, setWorktreeBase] = useState('')
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [busyPrompt, setBusyPrompt] = useState<{
    occupants: WorkspaceOccupant[]
    hasHistory: boolean
    resolve: (choice: WorkspaceBusyChoice) => Promise<boolean>
  } | null>(null)
  const [busyPromptWorking, setBusyPromptWorking] = useState(false)
  const [busyPromptError, setBusyPromptError] = useState<string | null>(null)
  const workspaceCheckRef = useRef(false)
  const shareNextRunRef = useRef(false)

  // A sub-agent opened from its row covers the chat until Back or Esc.
  const [openSubAgent, setOpenSubAgent] = useState<SubAgentTarget | null>(null)
  const closeSubAgent = useCallback(() => setOpenSubAgent(null), [])
  const [subAgentConversationId, setSubAgentConversationId] = useState(conversationId)
  if (subAgentConversationId !== conversationId) {
    // Another chat has no view of this one's sub-agent.
    setSubAgentConversationId(conversationId)
    setOpenSubAgent(null)
  }
  // The context meter follows what is on screen: an open sub-agent reports its own.
  const reportSubAgentContext = useCallback(
    (tokens: number) => tokenCountUpdateRef.current?.(tokens, selectedContextLength),
    [selectedContextLength]
  )

  // Rehydrate context telemetry with the persisted conversation. Without this,
  // a reopened chat displays zero until another provider response arrives.
  useEffect(() => {
    if (openSubAgent) return
    let latestUsage: Message['tokenUsage']
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'agent' && messages[index].tokenUsage) {
        latestUsage = messages[index].tokenUsage
        break
      }
    }
    tokenCountUpdateRef.current?.(
      latestUsage ? contextTokens(latestUsage) : 0,
      selectedContextLength
    )
  }, [messages, openSubAgent, selectedContextLength])
  // A chat's panel mounts when it is opened, so what was left unsent there is restored once.
  const [initialDraft] = useState(() => loadComposerDraft(composerDraftKey(conversationId)))
  const [inputValue, setInputValue] = useState(initialDraft.text)
  const [attachedImages, setAttachedImages] = useState<MessageImageAttachment[]>(
    initialDraft.images
  )
  const [attachedContext, setAttachedContext] = useState<MessageContextAttachment[]>(
    initialDraft.attachments
  )
  useComposerDraft(conversationId, {
    text: inputValue,
    images: attachedImages,
    attachments: attachedContext
  })
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  // Places marked on this chat's browser pages. The main process holds them until a message
  // takes them, so the chips follow its list.
  const [browserMarks, setBrowserMarks] = useState<BrowserAnnotationAttachment[]>([])
  const submitFromPageRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    setBrowserMarks([])
    if (!conversationId) return
    let stopped = false
    const load = (): void => {
      void window.api.agentRuns
        .browserAnnotations({ conversationId, action: 'list' })
        .then((marks) => {
          if (!stopped) setBrowserMarks(marks)
        })
        .catch(() => undefined)
    }
    load()
    const stop = window.api.agentRuns.onBrowserAnnotationsChanged((change) => {
      if (change.conversationId !== conversationId || change.error) return
      // Send on the page sends this chat's message, with the marks, as its send button would.
      if (change.send) submitFromPageRef.current()
      else load()
    })
    return () => {
      stopped = true
      stop()
    }
  }, [conversationId])
  const [nextRunMode, setNextRunMode] = useState<ConversationRunMode>('conversation')
  const [planModelOverrideId, setPlanModelOverrideId] = useState<string | null>(null)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [isFeaturesMenuOpen, setIsFeaturesMenuOpen] = useState(false)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const [workspaceRules, setWorkspaceRules] = useState<{
    content: string
    sources: string[]
    truncated: boolean
    error?: string
  }>({ content: '', sources: [], truncated: false })
  const [workspaceMemory, setWorkspaceMemory] = useState('')
  const [workspaceMemoryLoadedFor, setWorkspaceMemoryLoadedFor] = useState<string | null>(null)
  const [workspaceMemoryError, setWorkspaceMemoryError] = useState<string | null>(null)
  const [isWorkspaceMemoryOpen, setIsWorkspaceMemoryOpen] = useState(false)
  const [goalArmed, setGoalArmed] = useState(false)
  const [gitAvailableForWorkspace, setGitAvailableForWorkspace] = useState<boolean>(true) // git check result
  const [gitBannerDismissed, setGitBannerDismissed] = useState(false) // user dismissed git warning
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The message box's contents while a message is being edited in it, put back on Cancel.
  const sentAtRef = useRef(0)
  const riseMessageIdRef = useRef<string | null>(null)
  const seenMessagesRef = useRef<{
    conversationId: string | null
    ids: Set<string>
    count: number
    lastId: string | undefined
  } | null>(null)
  const editStashRef = useRef<{
    text: string
    images: MessageImageAttachment[]
    attachments: MessageContextAttachment[]
    mode: ConversationRunMode
    goalArmed: boolean
  } | null>(null)
  // A queued message being edited in the box, as a sent one is; sending saves it in the queue.
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null)
  const featuresMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  // Track artifact render results for tool response
  const artifactResultsRef = useRef<
    Map<string, { success: boolean; error?: string; code?: string }>
  >(new Map())
  const pendingGoalStartRef = useRef<string | null>(null)
  const pendingGoalSteerRef = useRef(false)
  const workspaceFolderRef = useRef(workspaceFolder)
  workspaceFolderRef.current = workspaceFolder
  // Where this chat's files and History are: its project's folder, or its own when it has none.
  const filesFolder = useChatFolder(conversationId, workspaceFolder) ?? workspaceFolder
  const {
    phase,
    activeMode,
    isLoading,
    isStopping,
    runConversationId,
    queuedMessages: messageQueue,
    pivotMessage: pivotPending,
    startRun,
    finishRun,
    requestStop: handleStopGeneration,
    submitDuringRun,
    updatePendingMessage,
    removePendingMessage,
    moveQueuedMessage,
    steerQueuedMessage,
    resolveInteraction,
    isRunActive,
    sendMessage: sendConversationMessage
  } = useConversationRun({
    conversationId,
    messagesRef,
    skipNextLoadRef,
    setMessages,
    setInputValue,
    onConversationCreated,
    onProjection: (projection) => {
      if (!openSubAgent)
        onTokenCountUpdate?.(contextTokens(projection.tokenUsage), selectedContextLength)
    }
  })
  const { goal, createGoal, pauseGoal, resumeGoal, clearGoal } = useConversationGoal(conversationId)

  // Commands the agent ran in this conversation, so each command row can show its terminal.
  useEffect(() => {
    if (conversationId) loadTerminalSessions(conversationId)
  }, [conversationId])

  useEffect(() => {
    if (conversationId) onFocusChainUpdate(conversationId, goal?.plan ?? [])
  }, [conversationId, goal?.plan, onFocusChainUpdate])

  // A finished goal is reported where the work is, not on the composer the
  // next message will be typed into. The notice carries the goal's own id so
  // reopening the conversation shows the stored one instead of adding another.
  //
  // The goal is marked complete by a tool call inside the run, before the
  // model's closing reply. Waiting for the run to end, and stamping the notice
  // then, keeps it after that reply both now and when the history is reloaded.
  useEffect(() => {
    observeGoal(goal)
    if (!conversationId || !goal || goal.conversationId !== conversationId) return
    if (!isCompletionToAnnounce(goal) || isLoading) return
    markCompletionAnnounced(goal.id)
    const noticeId = `goal-complete:${goal.id}`
    if (messagesRef.current.some((message) => message.id === noticeId)) return
    // The objective is the message the goal began with and the summary is what
    // the closing reply just said, so neither is repeated. Only the evidence is
    // kept, and it stays folded away.
    const detail = goal.completionVerification?.trim()
    const headline = 'Goal complete'
    const notice: Message = {
      id: noticeId,
      role: 'system',
      noticeTone: 'success',
      content: detail ? `${headline}\n\n${detail}` : headline,
      timestamp: Date.now()
    }
    setMessages((previous) =>
      previous.some((message) => message.id === noticeId) ? previous : [...previous, notice]
    )
    void window.api.conversations
      .saveMessage({
        id: notice.id,
        conversation_id: conversationId,
        role: notice.role,
        content: notice.content,
        noticeTone: notice.noticeTone,
        timestamp: notice.timestamp
      })
      .catch((error) => console.error('[Goal] Could not store the completion notice', error))
  }, [conversationId, goal, isLoading, messagesRef, setMessages])

  const busyConversationId = runConversationId ?? conversationId
  const busyConversationIdRef = useRef<string | null>(busyConversationId)
  busyConversationIdRef.current = busyConversationId

  useEffect(() => {
    onBusyStateChange?.(busyConversationId, isLoading)
  }, [busyConversationId, isLoading, onBusyStateChange])

  useEffect(() => {
    return () => onBusyStateChange?.(busyConversationIdRef.current, false)
  }, [onBusyStateChange])

  /** Puts back what the box held before an edit, of a sent message or a queued one. */
  const restoreEditStash = (): void => {
    const stash = editStashRef.current
    editStashRef.current = null
    setInputValue(stash?.text ?? '')
    setAttachedImages(stash?.images ?? [])
    setAttachedContext(stash?.attachments ?? [])
    setNextRunMode(stash?.mode ?? 'conversation')
    setGoalArmed(stash?.goalArmed ?? false)
  }

  const {
    editingMessageId,
    steppedBackFromId,
    copiedMessageId,
    pendingCheckpointRestore,
    startEditMessage: handleStartEditMessage,
    cancelEditMessage: handleCancelEditMessage,
    submitEdit,
    copyMessage: handleCopyMessage,
    requestCheckpointRestore: handleUndoCheckpoint,
    cancelCheckpointRestore,
    confirmCheckpointRestore: handleConfirmCheckpointRestore,
    retryMessage: handleRetryMessage,
    rewindToMessage: handleRewindToMessage
  } = useConversationActions({
    messages,
    setMessages,
    conversationId,
    selectedModel: selectedPinnedModel ? selectedModel : '',
    onModelUnavailable: () => setIsModelMenuOpen(true),
    isRunActive,
    workspaceFolder: filesFolder,
    restoreDraft: async (message, discardsGoalStart) => {
      if (discardsGoalStart && conversationId) {
        const current = await window.api.conversationGoals.current(conversationId)
        if (current && ['active', 'paused', 'blocked'].includes(current.status)) {
          await window.api.conversationGoals.clear(current.id)
        }
      }
      setInputValue(message.content)
      setAttachedImages(message.images ?? [])
      setAttachedContext(message.attachments ?? [])
      window.requestAnimationFrame(() => inputRef.current?.focus())
    },
    beginEdit: (message, source) => {
      setEditingQueuedId(null)
      // What the box held comes back if the edit is cancelled.
      editStashRef.current ??= {
        text: inputValue,
        images: attachedImages,
        attachments: attachedContext,
        mode: nextRunMode,
        goalArmed
      }
      setInputValue(message.content)
      setAttachedImages(message.images ?? [])
      setAttachedContext(message.attachments ?? [])
      setNextRunMode(
        message.runMode === 'plan' || message.runMode === 'research'
          ? message.runMode
          : 'conversation'
      )
      setGoalArmed(Boolean(message.startsGoal))
      setPlanModelOverrideId(null)
      // After the editing bar has rendered, so the message lands where its text now sits.
      window.requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        flyIntoComposer(source, input.closest<HTMLElement>('.input-container'))
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
      })
    },
    cancelEdit: () => restoreEditStash(),
    beforeMessagesLeave: (message, kind) => {
      const container = messagesContainerRef.current
      if (!container) return
      // The chat's own messages, not the ones a sub-agent's card shows inside them.
      const rendered = [
        ...container.querySelectorAll<HTMLElement>('.message[data-message-id]')
      ].filter((element) => !element.parentElement?.closest('.message'))
      const index = rendered.findIndex((element) => element.dataset.messageId === message.id)
      if (index < 0) return
      if (kind === 'rewind') {
        // It heads back into the box it came from.
        flyIntoComposer(
          rendered[index].querySelector<HTMLElement>('.message-bubble'),
          inputRef.current?.closest<HTMLElement>('.input-container') ?? null
        )
      }
      // An edited message comes back into focus with its new words as the old replies go.
      if (kind === 'edit') riseMessageIdRef.current = message.id
      return dissolveMessages(
        rendered.slice(kind === 'rewind' ? index : index + 1),
        container.getBoundingClientRect()
      )
    },
    rerunStream: async (truncatedMessages, targetConversationId, mode, rewoundGoal) => {
      if (rewoundGoal.restartObjective !== undefined || rewoundGoal.discardsGoalStart) {
        // The goal being replaced belonged to history this rewind removes.
        const current = await window.api.conversationGoals.current(targetConversationId)
        if (current && ['active', 'paused', 'blocked'].includes(current.status)) {
          await window.api.conversationGoals.clear(current.id)
        }
        // The goal being replaced no longer blocks a new one; only whether the
        // model can run a goal at all does.
        if (
          rewoundGoal.restartObjective !== undefined &&
          selectedPinnedModel &&
          selectedPinnedModel.supportsTools !== false
        ) {
          pendingGoalStartRef.current = rewoundGoal.restartObjective
        }
      }
      try {
        await streamAgentResponse(truncatedMessages, targetConversationId, false, undefined, mode)
      } finally {
        pendingGoalStartRef.current = null
      }
    }
  })

  const rewindToMessageRef = useRef(handleRewindToMessage)
  rewindToMessageRef.current = handleRewindToMessage
  const rewindMessage = useCallback(
    (message: Message, restoreFiles: boolean) =>
      void rewindToMessageRef.current(message, restoreFiles),
    []
  )

  useEffect(() => {
    if (!workspaceFolder) {
      setWorkspaceRules({ content: '', sources: [], truncated: false })
      return
    }

    let cancelled = false
    window.api.workspace
      .getRules(workspaceFolder)
      .then((result) => {
        if (!cancelled && result.ok) {
          setWorkspaceRules({
            content: result.content,
            sources: result.sources,
            truncated: result.truncated
          })
        } else if (!cancelled) {
          setWorkspaceRules({
            content: '',
            sources: [],
            truncated: false,
            error: result.error || 'Could not load project instructions'
          })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceRules({
            content: '',
            sources: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [conversationId, workspaceFolder])

  useEffect(() => {
    setWorkspaceMemory('')
    setWorkspaceMemoryLoadedFor(null)
    setWorkspaceMemoryError(null)
    setIsWorkspaceMemoryOpen(false)
    if (!workspaceFolder) {
      return
    }

    let cancelled = false
    window.api.memory
      .get(workspaceFolder)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setWorkspaceMemory(result.content)
          setWorkspaceMemoryLoadedFor(workspaceFolder)
          return
        }
        setWorkspaceMemoryError(result.error || 'Could not load shared project notes')
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('[WorkspaceMemory] Failed to load:', error)
        setWorkspaceMemoryError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
    }
  }, [workspaceFolder])

  useEffect(() => {
    // Check if git is available for checkpoint feature
    window.api.workspace
      .gitAvailable()
      .then((available) => {
        setGitAvailableForWorkspace(available)
      })
      .catch(() => {
        setGitAvailableForWorkspace(false)
      })
  }, [])

  const attachmentsConversationIdRef = useRef(conversationId)
  useEffect(() => {
    // The restored draft's attachments belong to this conversation; only a
    // later switch clears them.
    if (attachmentsConversationIdRef.current === conversationId) return
    attachmentsConversationIdRef.current = conversationId
    // Clear conversation-local presentation state. Prompt admissions reload from durable storage.
    artifactResultsRef.current.clear()
    setAttachedImages([])
    setAttachedContext([])
    setAttachmentError(null)
    setNextRunMode('conversation')
    // Arming belongs to the conversation it was chosen in.
    setGoalArmed(false)
  }, [conversationId])

  // Simple handler to track artifact render results (called by Artifact components).
  // Stable, so markdown fragments that receive it are not re-rendered on every
  // update of the streaming reply.
  const handleArtifactResult = useCallback(
    (title: string, result: { success: boolean; error?: string; code?: string }): void => {
      const existingResult = artifactResultsRef.current.get(title)
      if (existingResult && existingResult.success === false && result.success === true) {
        console.log(
          `[ChatPanel] Ignoring late success for "${title}" because a failure was already recorded`
        )
        return
      }
      if (existingResult?.success === true && result.success === false) {
        console.warn(
          `[ChatPanel] Artifact "${title}" reported a late runtime failure after initial success`
        )
      }
      console.log(
        `[ChatPanel] Artifact "${title}" result:`,
        result.success ? 'success' : `error: ${result.error}`
      )
      artifactResultsRef.current.set(title, result)
    },
    []
  )

  // Auto-scroll to bottom when messages change
  const { showScrollToBottom, scrollToBottom, revealStart } = useAutoScroll(
    messagesContainerRef,
    messages,
    'smooth',
    conversationId
  )
  const latestAnswer = useCallback((): HTMLElement | null => {
    const agentMessages =
      messagesContainerRef.current?.querySelectorAll<HTMLElement>('.message-agent')
    const last = agentMessages?.[agentMessages.length - 1]
    return last?.querySelector<HTMLElement>('[data-final-answer]') ?? last ?? null
  }, [])

  // Opening a conversation from its completion notification should land on the
  // reply the notification was about, not wherever the view happened to be.
  useEffect(() => {
    if (!focusReplyAt) return
    const timer = window.setTimeout(() => {
      const answer = latestAnswer()
      if (answer) revealStart(answer)
      else scrollToBottom()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [focusReplyAt, latestAnswer, revealStart, scrollToBottom])

  // A long answer followed to its end is read from its start. Wait for the
  // finished message, whose work has collapsed, to lay out first.
  const followedRunRef = useRef({ conversationId, isLoading })
  useEffect(() => {
    const previous = followedRunRef.current
    followedRunRef.current = { conversationId, isLoading }
    if (previous.conversationId !== conversationId || !previous.isLoading || isLoading) return
    const timer = window.setTimeout(() => {
      const answer = latestAnswer()
      if (answer) revealStart(answer, { onlyIfFollowing: true })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [conversationId, isLoading, latestAnswer, revealStart])

  /**
   * Moves a queued message into the box to edit, as Edit moves a sent one: it glides in from its
   * card, and sending saves the new text in the queue. What the box held waits until then.
   */
  const beginQueuedEdit = (message: PendingRunMessageItem, source: HTMLElement | null): void => {
    const original = editStashRef.current
    if (editingMessageId) handleCancelEditMessage()
    editStashRef.current = original ?? {
      text: inputValue,
      images: attachedImages,
      attachments: attachedContext,
      mode: nextRunMode,
      goalArmed
    }
    setEditingQueuedId(message.id)
    // Its images and files stay with it in the queue; the box edits its words.
    setInputValue(message.content)
    setAttachedImages([])
    setAttachedContext([])
    window.requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      flyIntoComposer(source, input.closest<HTMLElement>('.input-container'))
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
  }

  // A queued message sent while it was being edited leaves edit mode; its new words stay in the
  // box to send. Another chat ends the edit as well.
  const editedQueueChatRef = useRef(conversationId)
  useEffect(() => {
    if (!editingQueuedId) {
      editedQueueChatRef.current = conversationId
      return
    }
    const stillQueued =
      messageQueue.some((item) => item.id === editingQueuedId) ||
      pivotPending?.id === editingQueuedId
    if (stillQueued && editedQueueChatRef.current === conversationId) return
    editStashRef.current = null
    setEditingQueuedId(null)
  }, [editingQueuedId, messageQueue, pivotPending, conversationId])

  // Another chat ends dictation, so the microphone never follows the user elsewhere.
  const dictatedInRef = useRef(conversationId)
  useEffect(() => {
    if (dictatedInRef.current !== conversationId) endDictation()
    dictatedInRef.current = conversationId
  }, [conversationId])

  // Auto-focus input when conversation changes or loading completes
  useAutoFocus(inputRef, isLoading, false, conversationId)

  // Close menus when clicking outside
  useOutsideClick(
    [featuresMenuRef, modelMenuRef],
    () => {
      setIsFeaturesMenuOpen(false)
      setIsModelMenuOpen(false)
    },
    isFeaturesMenuOpen || isModelMenuOpen
  )

  // Escape must dismiss a popup menu the same way an outside click does, and
  // hand focus back to the composer so keyboard users are not left stranded.
  useEffect(() => {
    if (!isFeaturesMenuOpen && !isModelMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIsFeaturesMenuOpen(false)
      setIsModelMenuOpen(false)
      inputRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isFeaturesMenuOpen, isModelMenuOpen])

  const selectedProvider = selectedModel ? getProviderFromModel(selectedModel) : null
  const researchAvailable = Boolean(
    selectedPinnedModel && selectedPinnedModel.supportsTools !== false
  )
  const researchUnavailableReason = selectedPinnedModel
    ? selectedPinnedModel.supportsTools === false
      ? 'This model does not support the web tools required for research'
      : undefined
    : 'Select a model before starting research'
  const defaultPlanningModel =
    pinnedModels.find((model) => model.id === planningModelId && model.supportsTools !== false) ??
    selectedPinnedModel
  const selectedPlanningModel =
    pinnedModels.find(
      (model) => model.id === planModelOverrideId && model.supportsTools !== false
    ) ?? defaultPlanningModel
  const unfinishedGoal = Boolean(goal && ['active', 'paused', 'blocked'].includes(goal.status))
  const planAvailable = Boolean(
    selectedPinnedModel &&
    selectedPinnedModel.supportsTools !== false &&
    selectedPlanningModel &&
    selectedPlanningModel.supportsTools !== false &&
    !unfinishedGoal
  )
  const planUnavailableReason = unfinishedGoal
    ? 'Pause or clear the current persistent goal before starting a plan'
    : selectedPinnedModel?.supportsTools === false
      ? 'Plan execution requires a tool-capable chat model'
      : selectedPlanningModel?.supportsTools === false
        ? 'Select a tool-capable planning model'
        : selectedPinnedModel
          ? undefined
          : 'Select a model before starting Plan mode'
  const goalAvailable = Boolean(
    selectedPinnedModel && selectedPinnedModel.supportsTools !== false && !unfinishedGoal
  )
  const goalUnavailableReason = unfinishedGoal
    ? 'Resume, edit, or clear the current goal first'
    : selectedPinnedModel?.supportsTools === false
      ? 'Persistent goals require a tool-capable model'
      : selectedPinnedModel
        ? undefined
        : 'Select a model before starting a goal'
  useEffect(() => {
    if (nextRunMode === 'research' && !researchAvailable) {
      setNextRunMode('conversation')
    }
    if (nextRunMode === 'plan' && !planAvailable) {
      setNextRunMode('conversation')
    }
    if (goalArmed && !goalAvailable) setGoalArmed(false)
  }, [goalArmed, goalAvailable, nextRunMode, planAvailable, researchAvailable])
  // The same levels and resolution the main process uses when it sends the request.
  const reasoningModel: ReasoningModel | null = selectedPinnedModel
    ? {
        id: selectedPinnedModel.id,
        providerKind: selectedPinnedModel.providerKind ?? (selectedProvider as ProviderKind),
        model: selectedPinnedModel.providerModelId || selectedPinnedModel.id,
        supportsReasoning: selectedPinnedModel.supportsReasoning,
        reasoningLevels: selectedPinnedModel.reasoningLevels,
        reasoningDefault: selectedPinnedModel.reasoningDefault
      }
    : null
  const selectedReasoningOptions = reasoningModel ? reasoningOptions(reasoningModel) : null
  const selectedReasoningLevel = reasoningModel
    ? resolveReasoningLevel(reasoningModel, reasoningSettings)
    : undefined

  const toggleThinking = (messageId: string): void => {
    setExpandedThinking((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(messageId)) {
        newSet.delete(messageId)
      } else {
        newSet.add(messageId)
      }
      return newSet
    })
  }

  const handleApproveToolLimitDecision = (decisionId: string): void => {
    void resolveInteraction(decisionId, { approved: true })
  }

  const handleDenyToolLimitDecision = (decisionId: string): void => {
    void resolveInteraction(decisionId, { approved: false })
  }

  const streamAgentResponse = async (
    baseMessages: Message[],
    activeConversationId: string,
    isNewConversation: boolean,
    titleBaseMessage: Message | undefined,
    runMode: ConversationRunMode,
    continuesRunId?: string
  ): Promise<void> => {
    const chatModel = chatModelRef.current
    if (!chatModel.id) {
      alert('Please select a model first')
      return
    }
    const model = chatModel.model
    if (!model) {
      throw new Error(
        `${modelNameFromId(chatModel.id)} is no longer available. Choose another model for this chat.`
      )
    }
    // A reply already running stays as it is; starting another would be refused anyway.
    if (isRunActive()) return

    const pendingGoalObjective = pendingGoalStartRef.current
    if (pendingGoalObjective) {
      if (runMode === 'research') throw new Error('A goal cannot start in research-report mode')
      pendingGoalStartRef.current = null
      await createGoal(activeConversationId, pendingGoalObjective)
    }
    if (pendingGoalSteerRef.current) {
      pendingGoalSteerRef.current = false
      const current = await window.api.conversationGoals.current(activeConversationId)
      if (current && (current.status === 'paused' || current.status === 'blocked')) {
        await window.api.conversationGoals.resume(current.id)
      }
    }

    const assistantMessageId = crypto.randomUUID()
    const shouldGenerateTitle = Boolean(
      titleBaseMessage && (isNewConversation || isPlaceholderConversationTitle(conversationTitle))
    )
    if (shouldGenerateTitle && titleBaseMessage) {
      const titlePrompt = conversationTitlePrompt(titleBaseMessage)
      await onUpdateConversationTitle(
        activeConversationId,
        createFallbackConversationTitle(titlePrompt),
        'fallback'
      )
    }

    setMessages([
      ...baseMessages.filter((message) => !message.hidden),
      {
        id: assistantMessageId,
        role: 'agent',
        content: '',
        thinking: '',
        timestamp: Date.now(),
        runMode
      }
    ])

    let completed = false
    let failed = false
    let leftRunningReply = false
    const shareFolder = shareNextRunRef.current
    shareNextRunRef.current = false
    try {
      const finalPhase = await startRun({
        id: crypto.randomUUID(),
        conversationId: activeConversationId,
        assistantMessageId,
        model,
        plannerModel: selectedPlanningModel,
        mode: runMode,
        ...(continuesRunId ? { continuesRunId } : {}),
        ...(shareFolder ? { workspaceSharing: 'allow' as const } : {}),
        userLocation
      })
      completed = true
      failed = finalPhase === 'failed'

      if (shouldGenerateTitle && titleBaseMessage) {
        const persisted = await window.api.conversations.getMessages(activeConversationId)
        const assistant = persisted.find((message) => message.id === assistantMessageId)
        if (assistant?.content?.trim()) {
          const titlePrompt = conversationTitlePrompt(titleBaseMessage)
          const modelName = model.providerModelId || stripModelPrefix(model.name)
          const titleModel = fastModelName || modelName
          const identity = {
            id: activeConversationId,
            expectedTitle: createFallbackConversationTitle(titlePrompt)
          }
          void (async () => {
            const claim = await window.api.conversations.claimTitleBackfill(identity)
            if (!claim.claimed) return

            let applied = false
            const generatedTitle = await generateConversationTitle(
              {
                provider: model.provider,
                providerKind: model.providerKind,
                providerInstanceId: model.providerInstanceId,
                model: titleModel,
                contextLength: fastModelName
                  ? Math.min(model.contextLength || 32_768, FAST_MODEL_CONTEXT_LIMIT)
                  : model.contextLength || 32_768,
                onUpdateTitle: async (id, title) => {
                  const result = await window.api.conversations.completeTitleBackfill({
                    ...identity,
                    title
                  })
                  if (!result.applied) return
                  applied = true
                  onConversationTitleApplied(id, title)
                }
              },
              activeConversationId,
              createConversationTitleMessages(titlePrompt, assistant.content.slice(0, 500))
            )
            if (!generatedTitle && !applied) {
              await window.api.conversations.failTitleBackfill({
                ...identity,
                error: 'Title provider did not return a usable title'
              })
            }
          })().catch((error) => {
            console.warn('[Title] Failed to run guarded title generation:', error)
          })
        }
      }
    } catch (error) {
      if (error instanceof RunAlreadyActiveError) {
        // The window now follows the reply that was already running. Finishing here would stop
        // following it, and the conversation would refuse every message until a restart.
        leftRunningReply = true
        setMessages((previous) => previous.filter((item) => item.id !== assistantMessageId))
      } else {
        const message = workspaceBusyDisplayMessage(
          error instanceof Error ? error.message : 'Agent run failed'
        )
        setMessages((previous) =>
          previous.map((item) =>
            item.id === assistantMessageId ? { ...item, content: `Error: ${message}` } : item
          )
        )
      }
    } finally {
      const pendingMessage = leftRunningReply ? null : await finishRun()
      if (pendingMessage) {
        window.setTimeout(() => {
          void sendMessage(pendingMessage.content, {
            clearInput: false,
            conversationId: activeConversationId,
            mode: pendingMessage.mode,
            images: pendingMessage.images,
            attachments: pendingMessage.attachments
          })
        }, 50)
      } else if (completed && !failed && !leftRunningReply) {
        // A failed run is announced by the attention alert, which says what went wrong.
        onResponseComplete?.('Response complete. Ready for your next message.')
      }
    }
  }

  const sendMessage = async (
    content: string,
    options?: SendConversationMessageOptions
  ): Promise<void> => {
    await sendConversationMessage(content, streamAgentResponse, options)
  }

  const handleStartGoal = async (
    objective: string,
    images?: MessageImageAttachment[],
    attachments?: MessageContextAttachment[]
  ): Promise<void> => {
    if (!goalAvailable) throw new Error(goalUnavailableReason || 'A goal cannot start right now')
    pendingGoalStartRef.current = objective
    setNextRunMode('conversation')
    setIsFeaturesMenuOpen(false)
    try {
      await sendMessage(objective, {
        clearInput: true,
        mode: 'conversation',
        images,
        attachments,
        startsGoal: true
      })
    } finally {
      pendingGoalStartRef.current = null
    }
  }

  const handleResumeGoal = async (): Promise<void> => {
    if (!goal || !conversationId || isLoading) return
    await resumeGoal()
    await streamAgentResponse(messagesRef.current, conversationId, false, undefined, 'conversation')
  }

  // Continues an interrupted reply in a new run that starts from its journal.
  // The main process refuses a second continuation of the same interruption.
  const continueInterruptedRun = async (message: Message): Promise<void> => {
    if (isLoading || !conversationId || !message.runId) return
    await streamAgentResponse(
      messagesRef.current,
      conversationId,
      false,
      undefined,
      message.runMode ?? 'conversation',
      message.runId
    )
  }
  const continueRunRef = useRef(continueInterruptedRun)
  continueRunRef.current = continueInterruptedRun
  const continueRun = useCallback((message: Message) => continueRunRef.current(message), [])

  const handleStop = async (): Promise<void> => {
    if (goal?.status === 'active') await pauseGoal()
    else await handleStopGeneration()
  }

  // A goal run that took the message in is still active; there is nothing to
  // resume when the next run starts.
  const settleGoalSteer = (submission: DuringRunSubmission | false): void => {
    if (submission === 'steered') pendingGoalSteerRef.current = false
  }

  // Handle sending a message while the LLM is already responding
  const handleSendDuringLoading = async (
    content: string,
    images: MessageImageAttachment[],
    attachments: MessageContextAttachment[]
  ): Promise<void> => {
    if (goal?.status === 'active') pendingGoalSteerRef.current = true
    const submission = await submitDuringRun(
      content,
      nextRunMode,
      goal?.status === 'active' ? 'pivot' : undefined,
      images,
      attachments
    )
    settleGoalSteer(submission)
    if (submission) {
      setInputValue('')
      setAttachedImages([])
      setAttachedContext([])
      setNextRunMode('conversation')
    } else {
      pendingGoalSteerRef.current = false
    }
  }

  const startInWorktree = async (targetConversationId: string): Promise<void> => {
    if (!onStartInWorktree) throw new Error('Worktrees are not available here')
    await onStartInWorktree(targetConversationId, worktreeBase ? { baseRef: worktreeBase } : {})
  }

  /**
   * Settles where the next run works before the message is sent: a new worktree when the chat
   * chose one, and the user's call when another agent is already writing in the folder. The
   * runtime enforces the same rule; asking here keeps the message unsent until it is settled.
   */
  const prepareWorkspace = async (): Promise<boolean> => {
    if (!conversationId || !projectId) return true
    const fresh = messagesRef.current.length === 0
    const choosing = fresh && !worktree
    if (choosing && workIn === 'worktree' && worktreesAvailable) {
      setWorkspaceError(null)
      try {
        await startInWorktree(conversationId)
        rememberWorkInChoice('worktree')
        return true
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : String(error))
        return false
      }
    }
    if (choosing && worktreesAvailable) rememberWorkInChoice('folder')
    if (!goalArmed && nextRunMode === 'research') return true
    const occupants = await window.api.agentRuns
      .workspaceOccupants(conversationId)
      .catch(() => [] as WorkspaceOccupant[])
    if (!occupants.length) return true
    return new Promise<boolean>((settle) => {
      setBusyPromptError(null)
      setBusyPrompt({
        occupants,
        hasHistory: !fresh,
        resolve: async (choice) => {
          if (choice === 'cancel') {
            settle(false)
            return true
          }
          if (choice === 'share') {
            shareNextRunRef.current = true
            settle(true)
            return true
          }
          if (fresh) {
            await startInWorktree(conversationId)
            settle(true)
            return true
          }
          if (!onForkIntoWorktree) throw new Error('Worktrees are not available here')
          await onForkIntoWorktree(conversationId, {
            text: inputValue,
            images: attachedImages,
            attachments: attachedContext
          })
          setInputValue('')
          setAttachedImages([])
          setAttachedContext([])
          settle(false)
          return true
        }
      })
    })
  }

  const chooseBusyPromptOption = async (choice: WorkspaceBusyChoice): Promise<void> => {
    if (!busyPrompt || busyPromptWorking) return
    setBusyPromptWorking(true)
    setBusyPromptError(null)
    try {
      if (await busyPrompt.resolve(choice)) setBusyPrompt(null)
    } catch (error) {
      setBusyPromptError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyPromptWorking(false)
    }
  }

  const handleSubmit = (): void => {
    if (
      !inputValue.trim() &&
      !attachedImages.length &&
      !attachedContext.length &&
      !browserMarks.length
    )
      return
    if (unavailableModelName) {
      setIsModelMenuOpen(true)
      return
    }
    if (!isLoading && conversationId && projectId) {
      if (workspaceCheckRef.current) return
      workspaceCheckRef.current = true
      void prepareWorkspace()
        .then((ready) => {
          if (ready) submitMessage()
        })
        .finally(() => {
          workspaceCheckRef.current = false
        })
      return
    }
    submitMessage()
  }

  submitFromPageRef.current = handleSubmit

  const sendArrow = (): Element | null | undefined =>
    inputRef.current?.closest('.input-container')?.querySelector('.send-button svg')
  // The next message to appear rises out of the box, even into a chat created by sending it.
  const markSent = (): void => {
    sentAtRef.current = Date.now()
    liftSendArrow(sendArrow())
  }

  const submitMessage = (): void => {
    // What was dictated so far is in the box and goes with the message, and the mic stops.
    endDictation()
    if (attachedImages.length && !visionAvailable) {
      setAttachmentError(visionUnavailableReason || 'Image input is unavailable')
      return
    }
    // A queued message being edited keeps what it had; marks wait for the next message.
    if (browserMarks.length && !editingQueuedId && conversationId) {
      if (attachedContext.length + browserMarks.length > MAX_MESSAGE_CONTEXT_ATTACHMENTS) {
        setAttachmentError(
          `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} attachments`
        )
        return
      }
      // The main process hands over the marks as they are now, with the latest notes.
      void window.api.agentRuns
        .browserAnnotations({
          conversationId,
          action: 'take',
          ids: browserMarks.map((mark) => mark.id)
        })
        .then((marks) =>
          // A model that cannot see images still gets each mark's note and what it points at.
          submitMessageWith(
            visionAvailable ? marks : marks.map((mark) => ({ ...mark, image: undefined }))
          )
        )
        .catch((error) =>
          setAttachmentError(error instanceof Error ? error.message : String(error))
        )
      return
    }
    submitMessageWith([])
  }

  const submitMessageWith = (marks: BrowserAnnotationAttachment[]): void => {
    const images = attachedImages
    const attachments = marks.length ? [...attachedContext, ...marks] : attachedContext
    if (editingQueuedId) {
      // The queued message takes the new text, and the box gets back what it held.
      if (!updatePendingMessage(editingQueuedId, inputValue)) return
      restoreEditStash()
      setEditingQueuedId(null)
      return
    }
    if (editingMessageId) {
      // Sending an edit replaces the message and everything after it, then answers again.
      if (isLoading) return
      if (goalArmed && !inputValue.trim()) return
      editStashRef.current = null
      const edit = {
        content: inputValue,
        images,
        attachments,
        runMode: goalArmed ? ('conversation' as const) : nextRunMode,
        startsGoal: goalArmed
      }
      setInputValue('')
      setAttachedImages([])
      setAttachedContext([])
      setNextRunMode('conversation')
      setGoalArmed(false)
      setPlanModelOverrideId(null)
      liftSendArrow(sendArrow())
      submitEdit(edit)
      return
    }
    if (isLoading) {
      void handleSendDuringLoading(inputValue, images, attachments)
      return
    }
    if (goalArmed) {
      // The objective is the message. Images alone cannot state one.
      if (!inputValue.trim()) return
      setGoalArmed(false)
      setPlanModelOverrideId(null)
      setAttachedImages([])
      setAttachedContext([])
      markSent()
      void handleStartGoal(inputValue.trim(), images, attachments)
      return
    }
    const mode = nextRunMode
    setNextRunMode('conversation')
    setPlanModelOverrideId(null)
    setAttachedImages([])
    setAttachedContext([])
    markSent()
    void sendMessage(inputValue, { clearInput: true, mode, images, attachments })
  }

  const visionAvailable = selectedPinnedModel?.supportsVision !== false
  const visionUnavailableReason = selectedPinnedModel
    ? selectedPinnedModel.supportsVision === false
      ? 'The selected model does not support image input'
      : undefined
    : 'Select a model before attaching images'

  const addImageFiles = async (files: File[]): Promise<void> => {
    if (!visionAvailable || !selectedPinnedModel) {
      setAttachmentError(visionUnavailableReason || 'Image input is unavailable')
      return
    }
    const available = Math.max(0, MAX_MESSAGE_IMAGES - attachedImages.length)
    if (!available) {
      setAttachmentError(`A message can contain up to ${MAX_MESSAGE_IMAGES} images`)
      return
    }
    try {
      const additions = await Promise.all(files.slice(0, available).map(fileToMessageImage))
      setAttachedImages((previous) => [...previous, ...additions].slice(0, MAX_MESSAGE_IMAGES))
      setAttachmentError(
        files.length > available ? `Only ${MAX_MESSAGE_IMAGES} images can be attached` : null
      )
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach image')
    }
  }

  /** Where attached files go; a chat not saved yet is saved first, as sending would, to have one. */
  const attachmentFolder = async (): Promise<string | null> => {
    if (filesFolder) return filesFolder
    if (conversationId || workspaceFolder) return null
    const title = 'New chat'
    const created = await window.api.conversations.create(title, null, 'fallback')
    skipNextLoadRef.current = true
    onConversationCreated(created.id, title)
    const context = await window.api.projects.getConversationContext(created.id)
    return context.chatFolder ? context.workspaceRoot : null
  }

  const addContextAttachments = async (): Promise<void> => {
    const folder = await attachmentFolder()
    if (!folder) {
      setAttachmentError('Open a project before attaching files or folders')
      return
    }
    const result = await window.api.workspace.selectContextAttachments(folder)
    if (!result.ok) {
      setAttachmentError(result.error || 'Could not attach project context')
      return
    }
    if (result.canceled) return
    setAttachedContext((previous) => {
      const pastedAndComments = previous.filter(
        (attachment) => !isProjectContextAttachment(attachment)
      )
      const byPath = new Map(
        previous
          .filter(isProjectContextAttachment)
          .map((attachment) => [attachment.relativePath, attachment])
      )
      for (const attachment of result.attachments) byPath.set(attachment.relativePath, attachment)
      return [...byPath.values(), ...pastedAndComments].slice(0, MAX_MESSAGE_CONTEXT_ATTACHMENTS)
    })
    setAttachmentError(
      attachedContext.length + result.attachments.length > MAX_MESSAGE_CONTEXT_ATTACHMENTS
        ? `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} attachments`
        : null
    )
  }

  const addFileMention = (relativePath: string): void => {
    setAttachedContext((previous) => {
      if (
        previous.some(
          (attachment) =>
            isProjectContextAttachment(attachment) && attachment.relativePath === relativePath
        )
      ) {
        return previous
      }
      if (previous.length >= MAX_MESSAGE_CONTEXT_ATTACHMENTS) {
        setAttachmentError(
          `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} attachments`
        )
        return previous
      }
      return [
        ...previous,
        {
          id: crypto.randomUUID(),
          kind: 'file' as const,
          name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
          relativePath
        }
      ]
    })
  }

  const addPastedText = (text: string): void => {
    if (attachedContext.length >= MAX_MESSAGE_CONTEXT_ATTACHMENTS) {
      setAttachmentError(
        `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} attachments`
      )
      return
    }
    const budget = pastedTextBudget(selectedPinnedModel?.contextLength)
    const pastedCharacters = attachedContext
      .filter(isPastedTextAttachment)
      .reduce((total, attachment) => total + attachment.content.length, text.length)
    if (pastedCharacters > budget) {
      const model = selectedPinnedModel?.contextLength
        ? `about half of ${selectedPinnedModel.name}'s ${Math.round(selectedPinnedModel.contextLength / 1024)}K-token context`
        : 'what this model is assumed to fit'
      setAttachmentError(
        `This paste would bring the message to ${pastedCharacters.toLocaleString()} characters of pasted text; up to ${budget.toLocaleString()} fit, ${model}. Save it as a project file and attach that, so the agent reads it in parts.`
      )
      return
    }
    setAttachedContext((previous) => [
      ...previous,
      createPastedTextAttachment(text, crypto.randomUUID())
    ])
    setAttachmentError(null)
  }

  // Comments written on diff lines in this chat's change reviews become composer chips.
  // Stable, so the memoized messages that show those diffs are not re-rendered.
  const attachedContextRef = useRef(attachedContext)
  attachedContextRef.current = attachedContext
  const addReviewComment = useCallback((comment: ReviewCommentInput): boolean => {
    if (attachedContextRef.current.length >= MAX_MESSAGE_CONTEXT_ATTACHMENTS) {
      setAttachmentError(
        `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} attachments`
      )
      return false
    }
    const attachment = createReviewCommentAttachment(comment, crypto.randomUUID())
    attachedContextRef.current = [...attachedContextRef.current, attachment]
    setAttachedContext((previous) => [...previous, attachment])
    setAttachmentError(null)
    inputRef.current?.focus()
    return true
  }, [])

  // Turns a pasted attachment back into typed text, after whatever is already written.
  const insertPastedText = (id: string): void => {
    const attachment = attachedContext.find((candidate) => candidate.id === id)
    if (!attachment || !isPastedTextAttachment(attachment)) return
    setAttachedContext((previous) => previous.filter((candidate) => candidate.id !== id))
    setInputValue((previous) =>
      previous.trim() ? `${previous.trimEnd()}\n\n${attachment.content}` : attachment.content
    )
    setAttachmentError(null)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()

      const queuedMessageId = getQueuedMessageIdForEmptySubmit(
        isLoading,
        Boolean(
          inputValue.trim() ||
          attachedImages.length ||
          attachedContext.length ||
          browserMarks.length
        ),
        messageQueue
      )
      if (queuedMessageId) {
        if (goal?.status === 'active') pendingGoalSteerRef.current = true
        void steerQueuedMessage(queuedMessageId).then(settleGoalSteer)
        return
      }

      handleSubmit()
    }
  }

  // Helper functions for message navigation (reserved for future features)
  // const getNextAgentMessage = (index: number): Message | undefined => {
  //   for (let i = index + 1; i < messages.length; i += 1) {
  //     if (messages[i].role === 'agent') return messages[i]
  //   }
  //   return undefined
  // }

  // const getPreviousUserMessage = (index: number): Message | undefined => {
  //   for (let i = index - 1; i >= 0; i -= 1) {
  //     if (messages[i].role === 'user') return messages[i]
  //   }
  //   return undefined
  // }

  // Chats this one started, or the chat that started it, woven into the transcript by time.
  const sessionFamily = useSessionFamily(conversationId)
  const { family: chatFamily, role: familyRole, self: familySelf } = sessionFamily
  const familyMembers = useMemo(
    () =>
      new Map(
        chatFamily
          ? [chatFamily.manager, ...chatFamily.workers].map((member) => [
              member.conversationId,
              member
            ])
          : []
      ),
    [chatFamily]
  )
  const briefIds = useMemo(
    () =>
      conversationId
        ? workerBriefIds(conversationId, familyRole, sessionFamily.messages)
        : new Set<string>(),
    [familyRole, sessionFamily.messages, conversationId]
  )
  const visibleMessages = useMemo(
    () => messages.filter((msg) => !msg.hidden && !briefIds.has(msg.id)),
    [messages, briefIds]
  )
  const familyRows = useMemo(
    () =>
      conversationId
        ? sessionTimeline(
            conversationId,
            familyRole,
            sessionFamily.messages,
            visibleMessages.map((msg) => msg.timestamp)
          )
        : new Map<number, SessionTimelineRow[]>(),
    [conversationId, familyRole, sessionFamily.messages, visibleMessages]
  )
  const runTodos = useMemo(
    () => (familyRole === 'manager' ? latestRunTodos(messages) : []),
    [familyRole, messages]
  )
  const openChat = useCallback((id: string): void => onOpenConversation?.(id), [onOpenConversation])
  const workerIdentity = useMemo(
    () =>
      familyRole === 'worker' && familySelf && chatFamily
        ? {
            workerName: memberName(familySelf),
            managerTitle: chatFamily.manager.title,
            workplace: workerWorkplace(familySelf, worktree)
          }
        : null,
    [familyRole, familySelf, chatFamily, worktree]
  )
  const familyContext = {
    members: familyMembers,
    statuses: sessionFamily.statuses,
    manager: chatFamily?.manager ?? null,
    onOpenChat: openChat
  }
  const renderFamilyRow = (row: SessionTimelineRow): React.JSX.Element | null => {
    switch (row.kind) {
      case 'started':
        return <StartedChatsRow key={row.key} briefs={row.briefs} {...familyContext} />
      case 'received':
        return <ReceivedMessagesRow key={row.key} messages={row.messages} {...familyContext} />
      case 'brief':
        return (
          <BriefCard
            key={row.key}
            brief={row.message}
            managerTitle={chatFamily?.manager.title ?? 'its manager'}
            workspaceRoot={filesFolder}
          />
        )
      case 'message':
        return (
          <SessionMessageRow
            key={row.key}
            message={row.message}
            sender={
              row.message.fromConversationId
                ? familyMembers.get(row.message.fromConversationId)
                : undefined
            }
            onOpenChat={openChat}
          />
        )
    }
  }
  const renderFamilyRows = (gap: number): React.JSX.Element | null => {
    const rows = familyRows.get(gap)
    if (!rows?.length) return null
    return <div className="family-timeline">{rows.map(renderFamilyRow)}</div>
  }
  const promptRefinementHistory = useMemo(() => selectPromptRefinementHistory(messages), [messages])
  const getPromptHistory = useCallback(
    () => buildPromptHistoryEntries(messagesRef.current),
    [messagesRef]
  )
  const virtualizeMessages = visibleMessages.length >= 40
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 220,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    overscan: 8,
    enabled: virtualizeMessages
  })

  // New messages arrive with a little motion: what you send rises out of the box, replies ease
  // in. Opening a chat or loading its history shows everything at once.
  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    const seen = seenMessagesRef.current
    const lastId = visibleMessages.at(-1)?.id
    // A reply streaming in re-renders constantly; only a change of messages needs a look.
    if (
      seen?.conversationId === conversationId &&
      seen.count === visibleMessages.length &&
      seen.lastId === lastId &&
      !riseMessageIdRef.current
    ) {
      return
    }
    const ids = visibleMessages.map((message) => message.id)
    seenMessagesRef.current = {
      conversationId,
      ids: new Set(ids),
      count: ids.length,
      lastId
    }
    if (!container) return
    const element = (id: string): HTMLElement | null =>
      container.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(id)}"]`)
    const riseId = riseMessageIdRef.current
    if (riseId && ids.includes(riseId)) {
      riseMessageIdRef.current = null
      riseIntoChat(element(riseId))
    }
    const justSent = Date.now() - sentAtRef.current < 4_000
    const sameChat = seen?.conversationId === conversationId && seen.ids.size > 0
    if (!seen || (!sameChat && !justSent)) return
    // Only what joined the end of the chat: history paged in above is not new.
    let firstNew = ids.length
    while (firstNew > 0 && !seen.ids.has(ids[firstNew - 1])) firstNew -= 1
    if (firstNew === ids.length || ids.length - firstNew > 3) return
    for (const message of visibleMessages.slice(firstNew)) {
      if (message.role === 'user' && justSent) {
        sentAtRef.current = 0
        riseIntoChat(element(message.id))
      } else if (message.role !== 'user') easeInReply(element(message.id))
    }
  }, [conversationId, visibleMessages])

  // While a message is edited in the box, or replaced by sending it, it and everything after it
  // step back.
  const editingIndex = steppedBackFromId
    ? visibleMessages.findIndex((candidate) => candidate.id === steppedBackFromId)
    : -1
  // The last message whose reply changed this project's files and was not undone: rewinding to it,
  // or to any message before it, can take those files back.
  const lastFileChangeIndex = visibleMessages.findLastIndex(
    (message) =>
      Boolean(message.checkpointHash) &&
      message.checkpointWorkspaceRoot === filesFolder &&
      message.restoredFrom !== message.checkpointHash
  )
  const renderMessage = (msg: Message, index: number): React.JSX.Element => (
    <MessageItem
      key={msg.id}
      message={msg}
      index={index}
      isLoading={isLoading && index === visibleMessages.length - 1 && msg.role === 'agent'}
      expandedThinking={expandedThinking}
      editingMessageId={editingMessageId}
      isRewound={editingIndex >= 0 && index >= editingIndex}
      onToggleThinking={toggleThinking}
      onHandleArtifactResult={handleArtifactResult}
      onEditMessage={handleStartEditMessage}
      onCopyMessage={handleCopyMessage}
      onRetryMessage={handleRetryMessage}
      onContinueRun={
        !isLoading && index === visibleMessages.length - 1 && msg.role === 'agent'
          ? continueRun
          : undefined
      }
      onForkMessage={forkMessage}
      onRewindMessage={isLoading ? undefined : rewindMessage}
      rewindCanRestoreFiles={index <= lastFileChangeIndex}
      copiedMessageId={copiedMessageId}
      onApproveToolLimitDecision={handleApproveToolLimitDecision}
      onDenyToolLimitDecision={handleDenyToolLimitDecision}
      onResolveAgentInteraction={(id, response, cancelled) =>
        resolveInteraction(id, response, cancelled)
      }
      workspaceFolder={filesFolder}
      onUndoCheckpoint={handleUndoCheckpoint}
    />
  )

  const isEmptyChat = messages.length === 0 && !familyRows.size
  // Before the first message a chat can still choose where it works.
  const canChooseWorkspace =
    (Boolean(conversationId) || !projectId) && messages.length === 0 && !isLoading
  const panel = (
    <div className="chat-panel">
      {familyRole === 'worker' && familySelf && chatFamily && (
        <div className="worker-top">
          <WorkerChatHeader
            worker={familySelf}
            manager={chatFamily.manager}
            state={memberState(familySelf, sessionFamily.statuses)}
            reason={sessionFamily.statuses.get(familySelf.conversationId)?.reason}
            worktree={worktree}
            reportsToManager={Boolean(familySelf.reportToConversationId)}
            onOpenChat={openChat}
            onStop={() => window.api.sessions.stop(familySelf.conversationId)}
          />
        </div>
      )}
      {/* Messages Area */}
      <div
        className={`messages-container${isEmptyChat ? ' is-empty' : ''}`}
        ref={messagesContainerRef}
      >
        {isEmptyChat && <SidekickPeek />}
        {isEmptyChat ? (
          <div className="empty-state">
            <h2>{workspaceFolder ? projectName || 'Your project' : 'What’s next?'}</h2>
            {pinnedModels.length === 0 && <p className="hint">Choose a model below to start</p>}
            {pinnedModels.length > 0 && (
              <div className="starter-prompts" aria-label="Suggested prompts">
                {welcomeSuggestions.map((suggestion) => {
                  // Only the quoted title gives way, so the verb always says what a click does.
                  const quoted = /^(\S+) (“.*”)$/.exec(suggestion.label)
                  return (
                    <button
                      key={`${suggestion.label}:${suggestion.prompt}`}
                      type="button"
                      className="starter-prompt"
                      onClick={() => setInputValue(suggestion.prompt)}
                      title={suggestion.fullLabel ?? suggestion.label}
                    >
                      {quoted ? (
                        <span className="starter-prompt-label">
                          {quoted[1]} <span className="starter-prompt-topic">{quoted[2]}</span>
                        </span>
                      ) : (
                        <span className="starter-prompt-label">
                          <span className="starter-prompt-topic">{suggestion.label}</span>
                        </span>
                      )}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {virtualizeMessages ? (
              <div
                className="virtual-message-timeline"
                style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
              >
                {messageVirtualizer.getVirtualItems().map((virtualRow) => {
                  const msg = visibleMessages[virtualRow.index]
                  return (
                    <div
                      key={msg.id}
                      ref={messageVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      className={`virtual-message-row${
                        virtualRow.index === visibleMessages.length - 1 ? ' is-last' : ''
                      }`}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {virtualRow.index === 0 && renderFamilyRows(0)}
                      {renderMessage(msg, virtualRow.index)}
                      {renderFamilyRows(virtualRow.index + 1)}
                    </div>
                  )
                })}
              </div>
            ) : (
              <>
                {renderFamilyRows(0)}
                {visibleMessages.map((msg, index) => (
                  <Fragment key={msg.id}>
                    {renderMessage(msg, index)}
                    {renderFamilyRows(index + 1)}
                  </Fragment>
                ))}
              </>
            )}
            {runTodos.length > 0 && (
              <div className="family-timeline">
                <SessionTodoList
                  todos={runTodos}
                  members={familyMembers}
                  statuses={sessionFamily.statuses}
                  manager={chatFamily?.manager ?? null}
                  onOpenChat={openChat}
                />
              </div>
            )}
          </>
        )}
      </div>

      {familyRole === 'manager' && chatFamily && (
        <FamilyStrip
          workers={chatFamily.workers}
          statuses={sessionFamily.statuses}
          onStopAll={async (ids) => {
            await Promise.all(ids.map((id) => window.api.sessions.stop(id)))
          }}
        />
      )}
      <WorkspaceBar
        projectId={projectId}
        worktree={worktree}
        canChoose={canChooseWorkspace}
        workIn={workIn}
        baseRef={worktreeBase}
        error={workspaceError}
        onWorkInChange={(choice) => {
          setWorkIn(choice)
          setWorkspaceError(null)
        }}
        onBaseRefChange={setWorktreeBase}
        onManageWorktrees={() => onManageWorktrees?.()}
        onWorktreesAvailableChange={setWorktreesAvailable}
      />
      <WorkspaceBusyDialog
        isOpen={Boolean(busyPrompt)}
        occupants={busyPrompt?.occupants ?? []}
        hasHistory={busyPrompt?.hasHistory ?? false}
        canUseWorktree={Boolean(onStartInWorktree) && Boolean(projectId)}
        busy={busyPromptWorking}
        error={busyPromptError}
        onChoose={(choice) => void chooseBusyPromptOption(choice)}
      />

      {/* Input Area */}
      <ChatInput
        inputValue={inputValue}
        attachedImages={attachedImages}
        imageSendProfile={
          reasoningModel ? providerImageProfile(reasoningModel.providerKind) : undefined
        }
        attachedContext={attachedContext}
        browserMarks={browserMarks}
        onRemoveBrowserMark={(annotationId) => {
          if (!conversationId) return
          void window.api.agentRuns
            .browserWorkspace({ conversationId, action: 'annotationRemove', annotationId })
            .catch((error) =>
              setAttachmentError(error instanceof Error ? error.message : String(error))
            )
        }}
        attachmentError={attachmentError}
        visionAvailable={visionAvailable}
        visionUnavailableReason={visionUnavailableReason}
        isLoading={isLoading}
        isStopping={isStopping}
        editingMessageId={editingMessageId}
        onCancelEdit={handleCancelEditMessage}
        editingQueuedId={editingQueuedId}
        onEditQueuedMessage={beginQueuedEdit}
        onCancelQueuedEdit={() => {
          restoreEditStash()
          setEditingQueuedId(null)
        }}
        researchSelected={nextRunMode === 'research'}
        researchActive={activeMode === 'research'}
        researchPhase={phase}
        researchAvailable={researchAvailable}
        researchUnavailableReason={researchUnavailableReason}
        planSelected={nextRunMode === 'plan'}
        planActive={activeMode === 'plan'}
        planAvailable={planAvailable}
        planUnavailableReason={planUnavailableReason}
        planningModelId={selectedPlanningModel?.id || ''}
        planningModels={pinnedModels.filter((model) => model.supportsTools !== false)}
        executorModelName={selectedPinnedModel?.name || ''}
        goal={goal?.status === 'completed' ? null : goal}
        goalArmed={goalArmed}
        goalAvailable={goalAvailable}
        goalUnavailableReason={goalUnavailableReason}
        reasoningOptions={selectedReasoningOptions}
        reasoningLevel={selectedReasoningLevel}
        isFeaturesMenuOpen={isFeaturesMenuOpen}
        isModelMenuOpen={isModelMenuOpen}
        selectedModel={selectedModel}
        unavailableModelName={unavailableModelName}
        onChooseModel={() => setIsModelMenuOpen(true)}
        pinnedModels={pinnedModels}
        queuedMessages={messageQueue}
        pivotMessage={pivotPending}
        inputRef={inputRef}
        featuresMenuRef={featuresMenuRef}
        modelMenuRef={modelMenuRef}
        onInputChange={setInputValue}
        onAddImageFiles={(files) => void addImageFiles(files)}
        onAddContextAttachments={() => void addContextAttachments()}
        onAddFileMention={addFileMention}
        contextMeter={contextMeter}
        onAddPastedText={addPastedText}
        onInsertPastedText={insertPastedText}
        onRemoveImage={(id) => {
          setAttachedImages((previous) => previous.filter((image) => image.id !== id))
          setAttachmentError(null)
        }}
        onRemoveContextAttachment={(id) => {
          setAttachedContext((previous) => previous.filter((attachment) => attachment.id !== id))
          setAttachmentError(null)
        }}
        onKeyDown={handleKeyDown}
        onSendMessage={handleSubmit}
        onStopGeneration={() => {
          void handleStop()
        }}
        onToggleResearch={() => {
          if (!researchAvailable) return
          setNextRunMode((mode) => (mode === 'research' ? 'conversation' : 'research'))
          setGoalArmed(false)
          setIsFeaturesMenuOpen(false)
        }}
        onTogglePlan={() => {
          if (!planAvailable) return
          setNextRunMode((mode) => (mode === 'plan' ? 'conversation' : 'plan'))
          setGoalArmed(false)
          setIsFeaturesMenuOpen(false)
        }}
        onPlanModelChange={(modelId) => setPlanModelOverrideId(modelId || null)}
        onToggleGoal={() => {
          setGoalArmed((armed) => {
            if (armed) return false
            if (!goalAvailable) return false
            setNextRunMode('conversation')
            return true
          })
          setIsFeaturesMenuOpen(false)
        }}
        onPauseGoal={() => void pauseGoal()}
        onResumeGoal={() => void handleResumeGoal()}
        onClearGoal={() => void clearGoal()}
        onReasoningLevelChange={(level) => {
          if (selectedPinnedModel) onReasoningLevelChange(selectedPinnedModel.id, level)
        }}
        onToggleFeaturesMenu={() => setIsFeaturesMenuOpen(!isFeaturesMenuOpen)}
        onToggleModelMenu={() => setIsModelMenuOpen(!isModelMenuOpen)}
        onModelChange={onModelChange}
        onOpenModelSearch={onOpenModelSearch}
        permissionMode={commandPermissionMode}
        onPermissionModeChange={onPermissionModeChange}
        workspaceFolder={workspaceFolder}
        attachesToChatFolder={!workspaceFolder && (Boolean(filesFolder) || !conversationId)}
        toolbarExtra={
          worktree ? (
            <WorktreeChip worktree={worktree} onManage={() => onManageWorktrees?.()} />
          ) : canChooseWorkspace && !projectId && onChooseProject && projectChoices?.length ? (
            <ProjectChoiceChip
              projectChoices={projectChoices}
              onChooseProject={(id) => {
                setWorkspaceError(null)
                onChooseProject(id).catch((error: unknown) =>
                  setWorkspaceError(error instanceof Error ? error.message : String(error))
                )
              }}
            />
          ) : null
        }
        workspaceMemoryAvailable={workspaceMemoryLoadedFor === workspaceFolder}
        workspaceMemoryUnavailableReason={
          workspaceMemoryLoadedFor === workspaceFolder
            ? undefined
            : workspaceMemoryError || 'Loading shared project notes…'
        }
        onOpenWorkspace={async () => {
          await onOpenProject()
          setIsFeaturesMenuOpen(false)
        }}
        onOpenWorkspaceMemory={() => {
          if (workspaceFolder && workspaceMemoryLoadedFor === workspaceFolder) {
            setIsWorkspaceMemoryOpen(true)
          }
        }}
        onRemovePendingMessage={removePendingMessage}
        onMoveQueuedMessage={moveQueuedMessage}
        onSteerQueuedMessage={(id) => {
          if (goal?.status === 'active') pendingGoalSteerRef.current = true
          void steerQueuedMessage(id).then(settleGoalSteer)
        }}
        instructionSources={workspaceRules.sources}
        instructionsTruncated={workspaceRules.truncated}
        instructionError={workspaceRules.error}
        promptRefinementHistory={promptRefinementHistory}
        getPromptHistory={getPromptHistory}
        showScrollToBottom={showScrollToBottom}
        onScrollToBottom={scrollToBottom}
      />

      <WorkspaceMemoryModal
        isOpen={
          isWorkspaceMemoryOpen &&
          Boolean(workspaceFolder) &&
          workspaceMemoryLoadedFor === workspaceFolder
        }
        workspaceFolder={workspaceFolder ?? ''}
        initialContent={workspaceMemory}
        onClose={() => {
          const modalFolder = workspaceFolder
          if (workspaceFolderRef.current === modalFolder) setIsWorkspaceMemoryOpen(false)
        }}
        onSaved={(content) => {
          const modalFolder = workspaceFolder
          if (modalFolder && workspaceFolderRef.current === modalFolder) {
            setWorkspaceMemory(content)
            setWorkspaceMemoryLoadedFor(modalFolder)
          }
        }}
      />

      {/* D13: Git not available warning banner */}
      {workspaceFolder && !gitAvailableForWorkspace && !gitBannerDismissed && (
        <div className="git-warning-banner">
          <span>
            <AlertTriangle size={14} />
            git not found — checkpoints (undo) are disabled. Install git to enable workspace undo.
          </span>
          <button className="git-warning-dismiss" onClick={() => setGitBannerDismissed(true)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* D11: Checkpoint restore confirmation dialog */}
      <ConfirmDialog
        isOpen={pendingCheckpointRestore !== null}
        title="Undo these file changes?"
        message="SideKick will restore the files changed by this response to their earlier state. Unrelated edits stay untouched, and the undo stops if an affected file changed afterward."
        confirmText="Undo changes"
        cancelText="Cancel"
        variant="default"
        onConfirm={() => void handleConfirmCheckpointRestore()}
        onCancel={cancelCheckpointRestore}
      />

      {openSubAgent && (
        <SubAgentView
          key={openSubAgent.runId}
          target={openSubAgent}
          workspaceFolder={workspaceFolder}
          onBack={closeSubAgent}
          onContextUpdate={reportSubAgentContext}
        />
      )}
    </div>
  )

  return (
    <ReviewCommentSinkContext.Provider value={addReviewComment}>
      <SubAgentNavigation.Provider value={setOpenSubAgent}>
        <WorkerChatContext.Provider value={workerIdentity}>{panel}</WorkerChatContext.Provider>
      </SubAgentNavigation.Provider>
    </ReviewCommentSinkContext.Provider>
  )
}

export default ChatPanel
