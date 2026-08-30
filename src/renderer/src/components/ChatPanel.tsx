import { useState, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, ArrowUpRight, X } from 'lucide-react'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { useAutoFocus } from '../hooks/useAutoFocus'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { useConversationRun } from '../hooks/useConversationRun'
import { useConversationMessages } from '../hooks/useConversationMessages'
import { useConversationActions } from '../hooks/useConversationActions'
import { useConversationGoal } from '../hooks/useConversationGoal'
import { MessageItem } from './MessageItem'
import { ChatInput } from './ChatInput'
import ConfirmDialog from './ConfirmDialog'
import { WorkspaceMemoryModal } from './WorkspaceMemoryModal'
import { GoalDialog } from './GoalDialog'
import type { TodoItem } from '../../../shared/types'
import type { PermissionMode } from '../../../shared/permissions'
import type { ConversationTitleSource } from '../../../shared/conversationTitles'
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
import { createConversationTitleMessages } from '../services/prompts'
import { MAX_MESSAGE_IMAGES, type MessageImageAttachment } from '../../../shared/messageImages'
import {
  MAX_MESSAGE_CONTEXT_ATTACHMENTS,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'
import { fileToMessageImage } from '../utils/messageImageAttachments'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import './ChatPanel.css'

export type { PinnedModel }

interface ChatPanelProps {
  pinnedModels: PinnedModel[]
  onOpenModelSearch: () => void
  conversationId: string | null
  conversationTitle: string | null
  welcomeSuggestions: readonly WelcomeSuggestion[]
  workspaceFolder: string | null
  projectName: string | null
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
  userLocation?: { city?: string; country?: string; timezone?: string }
  onResponseComplete?: (message: string) => void
  onBusyStateChange?: (conversationId: string | null, busy: boolean) => void
  fastModelName?: string
  ollamaThinkingEnabled?: boolean
  openRouterThinkingEnabled?: boolean
  onToggleOllamaThinking: () => void
  onToggleOpenRouterThinking: () => void
  onCheckpointCreated?: (restoredHash?: string) => void
  /** When set to a checkpoint hash, rolls back this conversation to that checkpoint */
  chatRollbackHash?: string | null
  onChatRollbackConsumed?: () => void
}

function ChatPanel({
  pinnedModels,
  onOpenModelSearch,
  conversationId,
  conversationTitle,
  welcomeSuggestions,
  workspaceFolder,
  projectName,
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
  userLocation,
  onResponseComplete,
  onBusyStateChange,
  fastModelName,
  ollamaThinkingEnabled = true,
  openRouterThinkingEnabled = false,
  onToggleOllamaThinking,
  onToggleOpenRouterThinking,
  onCheckpointCreated,
  chatRollbackHash,
  onChatRollbackConsumed
}: ChatPanelProps): React.JSX.Element {
  const { messages, setMessages, messagesRef, skipNextLoadRef } = useConversationMessages({
    conversationId,
    rollbackHash: chatRollbackHash,
    onRollbackConsumed: onChatRollbackConsumed,
    onCostUpdate: onConversationCostUpdate
  })
  const selectedPinnedModel = pinnedModels.find((model) => model.id === selectedModel)
  const selectedContextLength = selectedPinnedModel?.contextLength ?? 32_768
  const tokenCountUpdateRef = useRef(onTokenCountUpdate)
  tokenCountUpdateRef.current = onTokenCountUpdate

  // Rehydrate context telemetry with the persisted conversation. Without this,
  // a reopened chat displays zero until another provider response arrives.
  useEffect(() => {
    let latestUsage: Message['tokenUsage']
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'agent' && messages[index].tokenUsage) {
        latestUsage = messages[index].tokenUsage
        break
      }
    }
    tokenCountUpdateRef.current?.(
      latestUsage ? latestUsage.promptTokens + latestUsage.completionTokens : 0,
      selectedContextLength
    )
  }, [messages, selectedContextLength])
  const [inputValue, setInputValue] = useState('')
  const [attachedImages, setAttachedImages] = useState<MessageImageAttachment[]>([])
  const [attachedContext, setAttachedContext] = useState<MessageContextAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isCompacting, setIsCompacting] = useState(false)
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
  const [goalDialogMode, setGoalDialogMode] = useState<'create' | 'edit' | null>(null)
  const [gitAvailableForWorkspace, setGitAvailableForWorkspace] = useState<boolean>(true) // git check result
  const [gitBannerDismissed, setGitBannerDismissed] = useState(false) // user dismissed git warning
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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
    sendMessage: sendConversationMessage
  } = useConversationRun({
    conversationId,
    messagesRef,
    skipNextLoadRef,
    setMessages,
    setInputValue,
    onConversationCreated,
    onProjection: (projection) => {
      setIsCompacting(projection.phase === 'compacting')
      onTokenCountUpdate?.(
        projection.tokenUsage.promptTokens + projection.tokenUsage.completionTokens,
        selectedContextLength
      )
    }
  })
  const { goal, createGoal, editGoal, pauseGoal, resumeGoal, clearGoal } =
    useConversationGoal(conversationId)

  useEffect(() => {
    if (conversationId) onFocusChainUpdate(conversationId, goal?.plan ?? [])
  }, [conversationId, goal?.plan, onFocusChainUpdate])

  const busyConversationId = runConversationId ?? conversationId
  const busyConversationIdRef = useRef<string | null>(busyConversationId)
  busyConversationIdRef.current = busyConversationId

  useEffect(() => {
    onBusyStateChange?.(busyConversationId, isLoading)
  }, [busyConversationId, isLoading, onBusyStateChange])

  useEffect(() => {
    return () => onBusyStateChange?.(busyConversationIdRef.current, false)
  }, [onBusyStateChange])

  const {
    editingMessageId,
    editingDraft,
    editingGeometry,
    copiedMessageId,
    pendingCheckpointRestore,
    setEditingDraft,
    startEditMessage: handleStartEditMessage,
    cancelEditMessage: handleCancelEditMessage,
    confirmEditMessage: handleConfirmEditMessage,
    copyMessage: handleCopyMessage,
    requestCheckpointRestore: handleUndoCheckpoint,
    cancelCheckpointRestore,
    confirmCheckpointRestore: handleConfirmCheckpointRestore,
    retryMessage: handleRetryMessage
  } = useConversationActions({
    messages,
    setMessages,
    conversationId,
    selectedModel,
    workspaceFolder,
    onCheckpointCreated,
    rerunStream: (truncatedMessages, targetConversationId, mode) =>
      streamAgentResponse(truncatedMessages, targetConversationId, false, undefined, mode)
  })

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

  useEffect(() => {
    // Clear conversation-local presentation state. Prompt admissions reload from durable storage.
    artifactResultsRef.current.clear()
    setAttachedImages([])
    setAttachedContext([])
    setAttachmentError(null)
    setNextRunMode('conversation')
  }, [conversationId])

  // Simple handler to track artifact render results (called by Artifact components)
  const handleArtifactResult = (
    title: string,
    result: { success: boolean; error?: string; code?: string }
  ): void => {
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
  }

  // Auto-scroll to bottom when messages change
  const { showScrollToBottom, scrollToBottom } = useAutoScroll(
    messagesEndRef,
    messagesContainerRef,
    messages,
    'smooth',
    conversationId
  )

  // Auto-focus input when conversation changes or loading completes
  useAutoFocus(inputRef, isLoading, editingMessageId !== null, conversationId)

  // Close menus when clicking outside
  useOutsideClick(
    [featuresMenuRef, modelMenuRef],
    () => {
      setIsFeaturesMenuOpen(false)
      setIsModelMenuOpen(false)
    },
    isFeaturesMenuOpen || isModelMenuOpen
  )

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
  }, [nextRunMode, planAvailable, researchAvailable])
  const thinkingAvailable =
    selectedProvider === 'ollama' ||
    selectedProvider === 'ollama-cloud' ||
    selectedProvider === 'openrouter'
  // Gateway/local providers auto-detect thinking from the model response.
  const thinkingEnabled =
    selectedProvider === 'openrouter'
      ? openRouterThinkingEnabled
      : selectedProvider === 'ollama' || selectedProvider === 'ollama-cloud'
        ? ollamaThinkingEnabled
        : selectedProvider === 'anthropic'
          ? true
          : selectedProvider === 'litellm' ||
              selectedProvider === 'lmstudio' ||
              selectedProvider === 'llamacpp'
            ? true
            : false

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
    runMode: ConversationRunMode
  ): Promise<void> => {
    if (!selectedModel) {
      alert('Please select a model first')
      return
    }
    const model = pinnedModels.find((candidate) => candidate.id === selectedModel)
    if (!model) throw new Error('The selected model is no longer available')

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
      const titlePrompt =
        titleBaseMessage.content || titleBaseMessage.images?.[0]?.name || 'Image conversation'
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
    try {
      await startRun({
        id: crypto.randomUUID(),
        conversationId: activeConversationId,
        assistantMessageId,
        model,
        plannerModel: selectedPlanningModel,
        mode: runMode,
        userLocation
      })
      completed = true

      if (shouldGenerateTitle && titleBaseMessage) {
        const persisted = await window.api.conversations.getMessages(activeConversationId)
        const assistant = persisted.find((message) => message.id === assistantMessageId)
        if (assistant?.content?.trim()) {
          const titlePrompt =
            titleBaseMessage.content || titleBaseMessage.images?.[0]?.name || 'Image conversation'
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
      const message = error instanceof Error ? error.message : 'Agent run failed'
      setMessages((previous) =>
        previous.map((item) =>
          item.id === assistantMessageId ? { ...item, content: `Error: ${message}` } : item
        )
      )
    } finally {
      const pendingMessage = await finishRun()
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
      } else if (completed) {
        onResponseComplete?.('Response complete. Ready for your next message.')
      }
    }
  }

  const sendMessage = async (
    content: string,
    options?: {
      clearInput?: boolean
      hideUserMessage?: boolean
      skipSave?: boolean
      conversationId?: string
      mode?: ConversationRunMode
      images?: MessageImageAttachment[]
      attachments?: MessageContextAttachment[]
    }
  ): Promise<void> => {
    await sendConversationMessage(content, streamAgentResponse, options)
  }

  const handleStartGoal = async (objective: string): Promise<void> => {
    if (!goalAvailable) throw new Error(goalUnavailableReason || 'A goal cannot start right now')
    pendingGoalStartRef.current = objective
    setNextRunMode('conversation')
    setIsFeaturesMenuOpen(false)
    try {
      await sendMessage(objective, { clearInput: true, mode: 'conversation' })
    } finally {
      pendingGoalStartRef.current = null
    }
  }

  const handleResumeGoal = async (): Promise<void> => {
    if (!goal || !conversationId || isLoading) return
    await resumeGoal()
    await streamAgentResponse(messagesRef.current, conversationId, false, undefined, 'conversation')
  }

  const handleStop = async (): Promise<void> => {
    if (goal?.status === 'active') await pauseGoal()
    else await handleStopGeneration()
  }

  // Handle sending a message while the LLM is already responding
  const handleSendDuringLoading = async (
    content: string,
    images: MessageImageAttachment[],
    attachments: MessageContextAttachment[]
  ): Promise<void> => {
    if (goal?.status === 'active') pendingGoalSteerRef.current = true
    if (
      await submitDuringRun(
        content,
        nextRunMode,
        goal?.status === 'active' ? 'pivot' : undefined,
        images,
        attachments
      )
    ) {
      setInputValue('')
      setAttachedImages([])
      setAttachedContext([])
      setNextRunMode('conversation')
    } else {
      pendingGoalSteerRef.current = false
    }
  }

  const handleSubmit = (): void => {
    if (!inputValue.trim() && !attachedImages.length && !attachedContext.length) return
    if (attachedImages.length && !visionAvailable) {
      setAttachmentError(visionUnavailableReason || 'Image input is unavailable')
      return
    }
    const images = attachedImages
    const attachments = attachedContext
    if (isLoading) {
      void handleSendDuringLoading(inputValue, images, attachments)
      return
    }
    const mode = nextRunMode
    setNextRunMode('conversation')
    setPlanModelOverrideId(null)
    setAttachedImages([])
    setAttachedContext([])
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

  const addContextAttachments = async (): Promise<void> => {
    if (!workspaceFolder) {
      setAttachmentError('Open a project before attaching files or folders')
      return
    }
    const result = await window.api.workspace.selectContextAttachments(workspaceFolder)
    if (!result.ok) {
      setAttachmentError(result.error || 'Could not attach project context')
      return
    }
    if (result.canceled) return
    setAttachedContext((previous) => {
      const byPath = new Map(previous.map((attachment) => [attachment.relativePath, attachment]))
      for (const attachment of result.attachments) byPath.set(attachment.relativePath, attachment)
      return [...byPath.values()].slice(0, MAX_MESSAGE_CONTEXT_ATTACHMENTS)
    })
    setAttachmentError(
      attachedContext.length + result.attachments.length > MAX_MESSAGE_CONTEXT_ATTACHMENTS
        ? `A message can contain up to ${MAX_MESSAGE_CONTEXT_ATTACHMENTS} file or folder references`
        : null
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (editingMessageId) return

      const queuedMessageId = getQueuedMessageIdForEmptySubmit(
        isLoading,
        Boolean(inputValue.trim() || attachedImages.length || attachedContext.length),
        messageQueue
      )
      if (queuedMessageId) {
        if (goal?.status === 'active') pendingGoalSteerRef.current = true
        void steerQueuedMessage(queuedMessageId)
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

  const visibleMessages = messages.filter((msg) => !msg.hidden)
  const promptRefinementHistory = useMemo(() => selectPromptRefinementHistory(messages), [messages])
  const virtualizeMessages = visibleMessages.length >= 40
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 220,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    overscan: 8,
    enabled: virtualizeMessages
  })

  const renderMessage = (msg: Message, index: number): React.JSX.Element => (
    <MessageItem
      key={msg.id}
      message={msg}
      index={index}
      isLoading={isLoading && index === visibleMessages.length - 1 && msg.role === 'agent'}
      expandedThinking={expandedThinking}
      editingMessageId={editingMessageId}
      editingGeometry={editingGeometry}
      editingContent={editingDraft}
      onToggleThinking={toggleThinking}
      onHandleArtifactResult={handleArtifactResult}
      onEditMessage={handleStartEditMessage}
      onCancelEditMessage={handleCancelEditMessage}
      onConfirmEditMessage={handleConfirmEditMessage}
      onCopyMessage={handleCopyMessage}
      onRetryMessage={handleRetryMessage}
      onForkMessage={() => onForkConversation(msg.id)}
      copiedMessageId={copiedMessageId}
      onSetEditingContent={setEditingDraft}
      onApproveToolLimitDecision={handleApproveToolLimitDecision}
      onDenyToolLimitDecision={handleDenyToolLimitDecision}
      onResolveAgentInteraction={(id, response, cancelled) =>
        resolveInteraction(id, response, cancelled)
      }
      workspaceFolder={workspaceFolder}
      onUndoCheckpoint={handleUndoCheckpoint}
    />
  )

  return (
    <div className="chat-panel">
      {/* Messages Area */}
      <div className="messages-container" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>{workspaceFolder ? projectName || 'Your project' : 'What’s next?'}</h2>
            {pinnedModels.length === 0 && (
              <p className="hint">Click the + button above to add a model</p>
            )}
            {pinnedModels.length > 0 && (
              <div className="starter-prompts" aria-label="Suggested prompts">
                {welcomeSuggestions.map((suggestion) => (
                  <button
                    key={`${suggestion.label}:${suggestion.prompt}`}
                    type="button"
                    className="starter-prompt"
                    onClick={() => setInputValue(suggestion.prompt)}
                    title={suggestion.label}
                  >
                    <span>{suggestion.label}</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))}
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
                      className="virtual-message-row"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {renderMessage(msg, virtualRow.index)}
                    </div>
                  )
                })}
              </div>
            ) : (
              visibleMessages.map(renderMessage)
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Area */}
      <ChatInput
        inputValue={inputValue}
        attachedImages={attachedImages}
        attachedContext={attachedContext}
        attachmentError={attachmentError}
        visionAvailable={visionAvailable}
        visionUnavailableReason={visionUnavailableReason}
        isLoading={isLoading}
        isStopping={isStopping}
        isCompacting={isCompacting}
        editingMessageId={editingMessageId}
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
        goal={goal}
        goalAvailable={goalAvailable}
        goalUnavailableReason={goalUnavailableReason}
        thinkingEnabled={thinkingEnabled}
        thinkingAvailable={thinkingAvailable}
        isFeaturesMenuOpen={isFeaturesMenuOpen}
        isModelMenuOpen={isModelMenuOpen}
        selectedModel={selectedModel}
        pinnedModels={pinnedModels}
        queuedMessages={messageQueue}
        pivotMessage={pivotPending}
        inputRef={inputRef}
        featuresMenuRef={featuresMenuRef}
        modelMenuRef={modelMenuRef}
        onInputChange={setInputValue}
        onAddImageFiles={(files) => void addImageFiles(files)}
        onAddContextAttachments={() => void addContextAttachments()}
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
          setIsFeaturesMenuOpen(false)
        }}
        onTogglePlan={() => {
          if (!planAvailable) return
          setNextRunMode((mode) => (mode === 'plan' ? 'conversation' : 'plan'))
          setIsFeaturesMenuOpen(false)
        }}
        onPlanModelChange={(modelId) => setPlanModelOverrideId(modelId || null)}
        onOpenGoal={() => {
          setGoalDialogMode('create')
          setIsFeaturesMenuOpen(false)
        }}
        onEditGoal={() => setGoalDialogMode('edit')}
        onPauseGoal={() => void pauseGoal()}
        onResumeGoal={() => void handleResumeGoal()}
        onClearGoal={() => void clearGoal()}
        onToggleThinking={() => {
          if (selectedProvider === 'openrouter') {
            onToggleOpenRouterThinking()
          } else if (selectedProvider === 'ollama' || selectedProvider === 'ollama-cloud') {
            onToggleOllamaThinking()
          }
        }}
        onToggleFeaturesMenu={() => setIsFeaturesMenuOpen(!isFeaturesMenuOpen)}
        onToggleModelMenu={() => setIsModelMenuOpen(!isModelMenuOpen)}
        onModelChange={onModelChange}
        onOpenModelSearch={onOpenModelSearch}
        workspaceFolder={workspaceFolder}
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
        onUpdatePendingMessage={updatePendingMessage}
        onRemovePendingMessage={removePendingMessage}
        onMoveQueuedMessage={moveQueuedMessage}
        onSteerQueuedMessage={(id) => {
          if (goal?.status === 'active') pendingGoalSteerRef.current = true
          void steerQueuedMessage(id)
        }}
        instructionSources={workspaceRules.sources}
        instructionsTruncated={workspaceRules.truncated}
        instructionError={workspaceRules.error}
        promptRefinementHistory={promptRefinementHistory}
        showScrollToBottom={showScrollToBottom}
        onScrollToBottom={scrollToBottom}
      />

      {goalDialogMode && (
        <GoalDialog
          isOpen
          mode={goalDialogMode}
          initialObjective={goalDialogMode === 'edit' ? goal?.objective : ''}
          onClose={() => setGoalDialogMode(null)}
          onSubmit={(objective) =>
            goalDialogMode === 'edit'
              ? editGoal(objective).then(() => undefined)
              : handleStartGoal(objective)
          }
        />
      )}

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
    </div>
  )
}

export default ChatPanel
