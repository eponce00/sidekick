import React from 'react'
import {
  AtSign,
  Brain,
  Check,
  Command,
  FileText,
  FolderOpen,
  ListChecks,
  Loader2,
  MessageSquareText,
  Microscope,
  ImagePlus,
  Paperclip,
  StickyNote,
  Plus,
  Square,
  Target,
  X
} from 'lucide-react'
import type { PinnedModel } from '../types/models.types'
import type { AgentRunPhase } from '../../../shared/agentRuntime'
import { ChatComposer } from './ChatComposer'
import { ChatModelPicker } from './ChatModelPicker'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { promptRefinementModelForPinnedModel } from '../services/providers/promptRefinement'
import type { ConversationGoal } from '../../../shared/conversationGoals'
import type { PromptRefinementHistorySelection } from '../utils/promptRefinementHistory'
import { ConversationGoalBar, GoalArmedBar } from './ConversationGoalBar'
import { QueuedMessageTray } from './QueuedMessageTray'
import type { PendingRunMessageItem } from '../hooks/useConversationRun'
import type { MessageImageAttachment } from '../../../shared/messageImages'
import {
  isPastedTextAttachment,
  isReviewCommentAttachment,
  reviewCommentLineLabel,
  shouldAttachPastedText,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'
import { clipboardImageFiles } from '../utils/messageImageAttachments'
import { ImageAttachmentPreview } from './ImageAttachmentPreview'
import { DictationButton } from './DictationButton'
import { useVoiceLoop } from '../services/voice/voiceLoop'
import { PastedTextAttachmentCard } from './PastedTextAttachment'
import {
  caretAllowsPromptHistoryStep,
  isBrowsingPromptHistory,
  stepPromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryPosition
} from '../utils/composerPromptHistory'
import {
  activeFileMentionAtCursor,
  insertFileMention,
  rankFileMentions
} from '../utils/fileMentions'
import { SAVED_PROMPT_ARGUMENTS, type SavedPrompt } from '../../../shared/savedPrompts'
import './ChatInput.css'

interface FeatureMenuActionProps {
  label: string
  description: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  unavailableReason?: string
  selected?: boolean
}

function FeatureMenuAction({
  label,
  description,
  icon,
  onClick,
  disabled = false,
  unavailableReason,
  selected = false
}: FeatureMenuActionProps): React.JSX.Element {
  const helpText = unavailableReason || description

  return (
    <button
      type="button"
      role="menuitem"
      className="features-menu-item features-menu-action"
      onClick={onClick}
      disabled={disabled}
      title={helpText}
      aria-label={`${label}. ${helpText}`}
    >
      <span className="features-menu-item-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="features-menu-item-label">{label}</span>
      {selected && (
        <span className="features-menu-item-check" aria-label="Selected">
          <Check size={15} />
        </span>
      )}
    </button>
  )
}

interface FeatureMenuStatusProps {
  label: string
  description: string
  title: string
  error?: boolean
}

function FeatureMenuStatus({
  label,
  description,
  title,
  error = false
}: FeatureMenuStatusProps): React.JSX.Element {
  return (
    <div
      className={`features-menu-status${error ? ' is-error' : ''}`}
      role="status"
      title={title}
      aria-label={`${label}. ${description}`}
    >
      <span className="features-menu-item-icon" aria-hidden="true">
        <FileText size={16} />
      </span>
      <span className="features-menu-item-label">{label}</span>
    </div>
  )
}

interface ChatInputProps {
  inputValue: string
  attachedImages: MessageImageAttachment[]
  attachedContext: MessageContextAttachment[]
  attachmentError: string | null
  visionAvailable: boolean
  visionUnavailableReason?: string
  isLoading: boolean
  isStopping: boolean
  isCompacting: boolean
  editingMessageId: string | null
  researchSelected: boolean
  researchActive: boolean
  researchPhase: AgentRunPhase | 'idle'
  researchAvailable: boolean
  researchUnavailableReason?: string
  planSelected: boolean
  planActive: boolean
  planAvailable: boolean
  planUnavailableReason?: string
  planningModelId: string
  planningModels: PinnedModel[]
  executorModelName: string
  goal: ConversationGoal | null
  goalArmed: boolean
  goalAvailable: boolean
  goalUnavailableReason?: string
  thinkingEnabled: boolean
  thinkingAvailable: boolean
  isFeaturesMenuOpen: boolean
  isModelMenuOpen: boolean
  selectedModel: string
  pinnedModels: PinnedModel[]
  queuedMessages: PendingRunMessageItem[]
  pivotMessage: PendingRunMessageItem | null
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  featuresMenuRef: React.RefObject<HTMLDivElement | null>
  modelMenuRef: React.RefObject<HTMLDivElement | null>
  onInputChange: (value: string) => void
  onAddImageFiles: (files: File[]) => void
  onAddContextAttachments: () => void
  /** Attaches a project file named with `@` in the message, so it is read before the reply. */
  onAddFileMention?: (relativePath: string) => void
  onAddPastedText: (text: string) => void
  onInsertPastedText: (id: string) => void
  onRemoveImage: (id: string) => void
  onRemoveContextAttachment: (id: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSendMessage: () => void
  onStopGeneration: () => void
  onToggleResearch: () => void
  onTogglePlan: () => void
  onPlanModelChange: (modelId: string) => void
  onToggleGoal: () => void
  onPauseGoal: () => void
  onResumeGoal: () => void
  onClearGoal: () => void
  onToggleThinking: () => void
  onToggleFeaturesMenu: () => void
  onToggleModelMenu: () => void
  onModelChange: (modelId: string) => void
  onOpenModelSearch: () => void
  workspaceFolder: string | null
  onOpenWorkspace: () => void
  onOpenWorkspaceMemory: () => void
  workspaceMemoryAvailable: boolean
  workspaceMemoryUnavailableReason?: string
  onUpdatePendingMessage: (id: string, content: string) => boolean
  onRemovePendingMessage: (id: string) => void
  onMoveQueuedMessage: (id: string, toIndex: number) => void
  onSteerQueuedMessage: (id: string) => void
  instructionSources?: string[]
  instructionsTruncated?: boolean
  instructionError?: string
  promptRefinementHistory?: PromptRefinementHistorySelection
  /** This conversation's earlier prompts, oldest first, read when ArrowUp recalls one. */
  getPromptHistory?: () => readonly PromptHistoryEntry[]
  showScrollToBottom?: boolean
  onScrollToBottom?: () => void
}

export function ChatInput({
  inputValue,
  attachedImages,
  attachedContext,
  attachmentError,
  visionAvailable,
  visionUnavailableReason,
  isLoading,
  isStopping,
  isCompacting: _isCompacting,
  editingMessageId,
  researchSelected,
  researchActive,
  researchPhase,
  researchAvailable,
  researchUnavailableReason,
  planSelected,
  planActive,
  planAvailable,
  planUnavailableReason,
  planningModelId,
  planningModels,
  executorModelName,
  goal,
  goalArmed,
  goalAvailable,
  goalUnavailableReason,
  thinkingEnabled,
  thinkingAvailable,
  isFeaturesMenuOpen,
  isModelMenuOpen,
  selectedModel,
  pinnedModels,
  queuedMessages,
  pivotMessage,
  inputRef,
  featuresMenuRef,
  modelMenuRef,
  onInputChange,
  onAddImageFiles,
  onAddContextAttachments,
  onAddPastedText,
  onInsertPastedText,
  onRemoveImage,
  onRemoveContextAttachment,
  onKeyDown,
  onSendMessage,
  onStopGeneration,
  onToggleResearch,
  onTogglePlan,
  onPlanModelChange,
  onToggleGoal,
  onPauseGoal,
  onResumeGoal,
  onClearGoal,
  onToggleThinking,
  onToggleFeaturesMenu,
  onToggleModelMenu,
  onModelChange,
  onOpenModelSearch,
  workspaceFolder,
  onOpenWorkspace,
  onOpenWorkspaceMemory,
  workspaceMemoryAvailable,
  workspaceMemoryUnavailableReason,
  onUpdatePendingMessage,
  onRemovePendingMessage,
  onMoveQueuedMessage,
  onSteerQueuedMessage,
  instructionSources = [],
  instructionsTruncated = false,
  instructionError,
  promptRefinementHistory,
  getPromptHistory,
  showScrollToBottom = false,
  onScrollToBottom = () => undefined,
  onAddFileMention
}: ChatInputProps) {
  const imageInputRef = React.useRef<HTMLInputElement>(null)
  // With voice on, the empty box says what the conversation is doing.
  const voiceLoop = useVoiceLoop()
  // Ctrl+Shift+V pastes long text into the message itself instead of attaching it.
  const plainPasteRef = React.useRef(false)
  const [commandIndex, setCommandIndex] = React.useState(0)
  const [savedPrompts, setSavedPrompts] = React.useState<SavedPrompt[]>([])
  const [caret, setCaret] = React.useState(inputValue.length)
  const [fileIndex, setFileIndex] = React.useState(0)
  const [projectFiles, setProjectFiles] = React.useState<{ root: string; files: string[] } | null>(
    null
  )
  // Escape closes the menu for the mention being typed; typing a new `@` opens it again.
  const [dismissedMentionStart, setDismissedMentionStart] = React.useState<number | null>(null)
  const promptHistoryRef = React.useRef<PromptHistoryPosition | null>(null)
  const selectedPinnedModel = selectedModel
    ? pinnedModels.find((m) => m.id === selectedModel)
    : undefined
  const researchPhaseLabel =
    researchPhase === 'queued'
      ? 'Preparing research'
      : researchPhase === 'executing_tool'
        ? 'Checking sources'
        : researchPhase === 'compacting'
          ? 'Organizing evidence'
          : researchPhase === 'stopping'
            ? 'Stopping research'
            : researchPhase === 'awaiting_permission' || researchPhase === 'awaiting_user'
              ? 'Research needs your input'
              : 'Researching'
  const commands = React.useMemo(
    () => [
      {
        id: 'model',
        label: 'Choose model',
        hint: 'Switch or manage models',
        keywords: 'model provider',
        run: onToggleModelMenu
      },
      {
        id: 'plan',
        label: planSelected ? 'Turn off Plan mode' : 'Plan first',
        hint: 'Plan before making changes',
        keywords: 'plan mode',
        disabled: !planAvailable,
        run: onTogglePlan
      },
      {
        id: 'research',
        label: researchSelected ? 'Turn off Research' : 'Research report',
        hint: 'Search and cross-check web sources',
        keywords: 'research web sources',
        disabled: !researchAvailable,
        run: onToggleResearch
      },
      {
        id: 'goal',
        label: goalArmed ? 'Turn off Goal' : 'Ongoing goal',
        hint: 'Keep working toward an objective across messages',
        keywords: 'goal task objective',
        disabled: !goalAvailable && !goalArmed,
        run: onToggleGoal
      },
      {
        id: 'project',
        label: workspaceFolder ? 'Change project folder' : 'Open project folder',
        hint: 'Select the working directory',
        keywords: 'workspace folder project',
        run: onOpenWorkspace
      },
      ...(workspaceFolder
        ? [
            {
              id: 'memory',
              label: 'Shared project notes',
              hint:
                workspaceMemoryUnavailableReason ||
                'Edit SideKick notes shared across this project',
              keywords: 'workspace memory notes shared context',
              disabled: !workspaceMemoryAvailable,
              run: onOpenWorkspaceMemory
            }
          ]
        : []),
      ...(thinkingAvailable
        ? [
            {
              id: 'thinking',
              label: thinkingEnabled ? 'Turn off Thinking' : 'Turn on Thinking',
              hint: 'Control model reasoning mode',
              keywords: 'reasoning thinking',
              run: onToggleThinking
            }
          ]
        : [])
    ],
    [
      goalArmed,
      goalAvailable,
      onToggleGoal,
      onOpenWorkspace,
      onOpenWorkspaceMemory,
      onToggleModelMenu,
      onTogglePlan,
      onToggleResearch,
      onToggleThinking,
      planAvailable,
      planSelected,
      researchAvailable,
      researchSelected,
      thinkingAvailable,
      thinkingEnabled,
      workspaceFolder,
      workspaceMemoryAvailable,
      workspaceMemoryUnavailableReason
    ]
  )
  const commandMatch = /^\/([^\s]*)$/.exec(inputValue)
  const commandQuery = commandMatch?.[1].toLowerCase() ?? ''
  const commandMenuOpen = Boolean(commandMatch)
  React.useEffect(() => {
    if (!commandMenuOpen) return
    let cancelled = false
    // Read each time the menu opens, so a prompt saved a moment ago is offered.
    void window.api.workspace.listPrompts(workspaceFolder).then((result) => {
      if (!cancelled && result.ok) setSavedPrompts(result.prompts)
    })
    return () => {
      cancelled = true
    }
  }, [commandMenuOpen, workspaceFolder])
  // A selection to make once the box shows the text it belongs to; the text arrives a render later.
  const pendingSelectionRef = React.useRef<{ value: string; start: number; end: number } | null>(
    null
  )
  React.useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    const input = inputRef.current
    if (!pending || !input || input.value !== pending.value) return
    pendingSelectionRef.current = null
    input.focus()
    input.setSelectionRange(pending.start, pending.end)
    setCaret(pending.end)
  }, [inputValue, inputRef])
  const applySavedPrompt = (prompt: SavedPrompt): void => {
    // Typing replaces the arguments placeholder, so the prompt is filled in where it expects.
    const at = prompt.body.indexOf(SAVED_PROMPT_ARGUMENTS)
    pendingSelectionRef.current =
      at >= 0
        ? { value: prompt.body, start: at, end: at + SAVED_PROMPT_ARGUMENTS.length }
        : { value: prompt.body, start: prompt.body.length, end: prompt.body.length }
    onInputChange(prompt.body)
  }
  const allCommands = [
    ...commands,
    ...savedPrompts
      .filter((prompt) => !commands.some((command) => command.id === prompt.name.toLowerCase()))
      .map((prompt) => ({
        id: prompt.name,
        label: prompt.description || 'Saved prompt',
        hint: prompt.location,
        keywords: `saved prompt ${prompt.body.slice(0, 200)}`,
        disabled: false,
        run: () => applySavedPrompt(prompt)
      }))
  ]
  const visibleCommands = commandMatch
    ? allCommands.filter((command) =>
        `${command.id} ${command.label} ${command.keywords}`.toLowerCase().includes(commandQuery)
      )
    : []

  React.useEffect(() => setCommandIndex(0), [commandQuery])

  // The caret also moves without typing, by arrow keys or a click.
  React.useEffect(() => {
    const onSelectionChange = (): void => {
      const input = inputRef.current
      if (input && document.activeElement === input) setCaret(input.selectionStart)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [inputRef])

  const typedMention =
    !commandMatch && workspaceFolder && onAddFileMention && !editingMessageId
      ? activeFileMentionAtCursor(inputValue, Math.min(caret, inputValue.length))
      : null
  const fileMention =
    typedMention && typedMention.start !== dismissedMentionStart ? typedMention : null
  const mentionFiles = React.useMemo(
    () =>
      fileMention && projectFiles?.root === workspaceFolder
        ? rankFileMentions(projectFiles.files, fileMention.query)
        : [],
    [fileMention, projectFiles, workspaceFolder]
  )
  const fileMentionActive = Boolean(fileMention)
  React.useEffect(() => {
    if (!fileMentionActive || !workspaceFolder) return
    let cancelled = false
    // Listed each time the menu opens, so files made since the last mention appear.
    void window.api.workspace.listFiles(workspaceFolder).then((result) => {
      if (!cancelled && result.ok) setProjectFiles({ root: workspaceFolder, files: result.files })
    })
    return () => {
      cancelled = true
    }
  }, [fileMentionActive, workspaceFolder])
  React.useEffect(() => setFileIndex(0), [fileMention?.query])

  const chooseFile = (index: number): void => {
    const path = mentionFiles[index]
    if (!path || !fileMention || !onAddFileMention) return
    const next = insertFileMention(inputValue, fileMention, caret, path)
    pendingSelectionRef.current = { value: next.value, start: next.caret, end: next.caret }
    onInputChange(next.value)
    onAddFileMention(path)
  }

  const runCommand = (index: number): void => {
    const command = visibleCommands[index]
    if (!command || command.disabled) return
    onInputChange('')
    command.run()
  }

  // Returns whether the key recalled an earlier prompt instead of moving the caret.
  const recallPrompt = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !getPromptHistory) return false
    const textarea = event.currentTarget
    const direction = event.key === 'ArrowUp' ? 'backward' : 'forward'
    const position = promptHistoryRef.current
    if (
      !caretAllowsPromptHistoryStep({
        direction,
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        browsing: isBrowsingPromptHistory(position, textarea.value)
      })
    ) {
      return false
    }
    const step = stepPromptHistory({
      direction,
      entries: getPromptHistory(),
      position,
      currentPrompt: textarea.value
    })
    if (!step) return false
    event.preventDefault()
    promptHistoryRef.current = step.position
    onInputChange(step.prompt)
    // The caret goes to the end, so another press keeps stepping through
    // single-line prompts and moves through the lines of a longer one first.
    window.requestAnimationFrame(() => {
      const input = inputRef.current
      if (input?.value === step.prompt)
        input.setSelectionRange(step.prompt.length, step.prompt.length)
    })
    return true
  }

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    plainPasteRef.current =
      (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v'
    if (commandMatch && visibleCommands.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandIndex((current) => (current + 1) % visibleCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandIndex(
          (current) => (current - 1 + visibleCommands.length) % visibleCommands.length
        )
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        runCommand(commandIndex)
        return
      }
    }
    if (fileMention && mentionFiles.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setFileIndex((current) => (current + step + mentionFiles.length) % mentionFiles.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        chooseFile(fileIndex)
        return
      }
    }
    if (fileMention && event.key === 'Escape') {
      event.preventDefault()
      setDismissedMentionStart(fileMention.start)
      return
    }
    if (commandMatch && event.key === 'Escape') {
      event.preventDefault()
      onInputChange('')
      return
    }
    if (recallPrompt(event)) return
    onKeyDown(event)
  }
  const runFeatureAction = (action: () => void): void => {
    action()
    onToggleFeaturesMenu()
  }
  const instructionStatusDescription = instructionError
    ? 'Instruction files could not be loaded'
    : instructionSources.length
      ? `${instructionSources.length} instruction file${instructionSources.length === 1 ? '' : 's'} loaded automatically${instructionsTruncated ? ' · some content truncated' : ''}`
      : 'No AGENTS.md or SideKick rule files loaded'
  const instructionStatusTitle =
    instructionError ||
    (instructionSources.length
      ? `Loaded automatically:\n${instructionSources.join('\n')}${instructionsTruncated ? '\nSome instruction content was truncated' : ''}`
      : 'SideKick automatically loads AGENTS.md, SIDEKICK.md, and scoped project rule files when present.')
  return (
    <ChatComposer
      value={inputValue}
      inputRef={inputRef}
      disabled={Boolean(editingMessageId)}
      placeholder={
        voiceLoop === 'listening'
          ? 'Listening… press Enter to send'
          : voiceLoop === 'waiting'
            ? 'Waiting for the reply…'
            : voiceLoop === 'speaking'
              ? 'Reading the reply aloud · Esc to skip'
              : goalArmed
                ? 'Describe the outcome and how SideKick should prove it works…'
                : goal?.status === 'active'
                  ? 'Steer the goal or add a constraint…'
                  : planActive
                    ? 'Add guidance while the plan is running…'
                    : planSelected
                      ? 'What should SideKick plan?'
                      : researchActive
                        ? 'Add a follow-up or steer the research…'
                        : researchSelected
                          ? 'What should SideKick research?'
                          : 'Type a message...'
      }
      contextBar={
        goal ? (
          <ConversationGoalBar
            goal={goal}
            isRunning={isLoading}
            onPause={onPauseGoal}
            onResume={onResumeGoal}
            onClear={onClearGoal}
          />
        ) : goalArmed ? (
          <GoalArmedBar onCancel={onToggleGoal} />
        ) : planSelected || planActive ? (
          <div className={`plan-mode-bar ${planActive ? 'is-running' : 'is-selected'}`}>
            <span className="plan-mode-icon" aria-hidden="true">
              {planActive ? <Loader2 size={14} className="icon-spin" /> : <ListChecks size={14} />}
            </span>
            <span className="plan-mode-copy">
              <strong>{planActive ? 'Plan in progress' : 'Plan first'}</strong>
              <span>
                <select
                  value={planningModelId}
                  disabled={planActive}
                  onChange={(event) => onPlanModelChange(event.target.value)}
                  aria-label="Planning model"
                  title="Choose the planning model"
                >
                  {planningModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                <i aria-hidden="true">→</i>
                <span title={executorModelName}>{executorModelName || 'Current model'}</span>
              </span>
            </span>
            {planSelected && !planActive && (
              <button
                type="button"
                className="research-mode-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  onTogglePlan()
                }}
                title="Use normal conversation mode"
                aria-label="Remove Plan mode"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ) : researchSelected || researchActive ? (
          <div
            className={`research-mode-bar ${researchActive ? 'is-running' : 'is-selected'}`}
            role="status"
            aria-live="polite"
          >
            <span className="research-mode-icon" aria-hidden="true">
              {researchActive ? (
                <Loader2 size={14} className="icon-spin" />
              ) : (
                <Microscope size={14} />
              )}
            </span>
            <span className="research-mode-copy">
              <strong>{researchActive ? researchPhaseLabel : 'Research report'}</strong>
              <span>
                {researchActive
                  ? 'Searching, verifying, and citing sources'
                  : 'One response · web sources · cross-checked citations'}
              </span>
            </span>
            {researchSelected && !researchActive && (
              <button
                type="button"
                className="research-mode-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleResearch()
                }}
                title="Use normal conversation mode"
                aria-label="Remove research mode"
              >
                <X size={13} />
              </button>
            )}
          </div>
        ) : undefined
      }
      queueTray={
        queuedMessages.length || pivotMessage ? (
          <QueuedMessageTray
            queuedMessages={queuedMessages}
            pivotMessage={pivotMessage}
            onUpdate={onUpdatePendingMessage}
            onRemove={onRemovePendingMessage}
            onMove={onMoveQueuedMessage}
            onSteer={onSteerQueuedMessage}
          />
        ) : undefined
      }
      promptRefinement={
        selectedPinnedModel
          ? {
              model: promptRefinementModelForPinnedModel(selectedPinnedModel),
              context: {
                surface: workspaceFolder ? 'project' : 'conversation',
                projectName: workspaceFolder?.split(/[\\/]/).filter(Boolean).at(-1),
                activeObjective: goal?.objective,
                ...promptRefinementHistory
              }
            }
          : undefined
      }
      onChange={(value) => {
        onInputChange(value)
        setCaret(inputRef.current?.selectionStart ?? value.length)
      }}
      onKeyDown={handleComposerKeyDown}
      onPaste={(event) => {
        const plainPaste = plainPasteRef.current
        plainPasteRef.current = false
        const files = clipboardImageFiles(event.clipboardData.items)
        if (files.length) {
          event.preventDefault()
          onAddImageFiles(files)
          return
        }
        // An edited message keeps its attachments, so a long paste goes into its text.
        if (plainPaste || editingMessageId) return
        const text = event.clipboardData.getData('text/plain')
        if (!shouldAttachPastedText(text)) return
        event.preventDefault()
        onAddPastedText(text)
      }}
      onSend={onSendMessage}
      popover={
        commandMatch ? (
          <div className="composer-command-menu" id="composer-command-menu" role="listbox">
            <div className="composer-command-header">
              <Command size={12} aria-hidden="true" /> Commands
              <span>↑↓ navigate · Enter select · Esc close</span>
            </div>
            {visibleCommands.map((command, index) => (
              <button
                type="button"
                role="option"
                id={`composer-command-${command.id}`}
                aria-selected={index === commandIndex}
                className={index === commandIndex ? 'active' : ''}
                disabled={command.disabled}
                key={command.id}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => runCommand(index)}
              >
                <code>/{command.id}</code>
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.hint}</small>
                </span>
              </button>
            ))}
            {!visibleCommands.length && (
              <div className="composer-command-empty">No matching commands</div>
            )}
          </div>
        ) : fileMention ? (
          <div
            className="composer-command-menu is-files"
            id="composer-file-menu"
            role="listbox"
            aria-label="Project files"
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="composer-command-header">
              <AtSign size={12} aria-hidden="true" /> Files · read before the reply
              <span>↑↓ navigate · Enter attach · Esc close</span>
            </div>
            {mentionFiles.map((path, index) => {
              const slash = path.lastIndexOf('/')
              return (
                <button
                  type="button"
                  role="option"
                  id={`composer-file-${index}`}
                  aria-selected={index === fileIndex}
                  className={index === fileIndex ? 'active' : ''}
                  key={path}
                  title={path}
                  onMouseEnter={() => setFileIndex(index)}
                  onClick={() => chooseFile(index)}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span>
                    <strong>{path.slice(slash + 1)}</strong>
                    {slash > 0 && <small>{path.slice(0, slash)}</small>}
                  </span>
                </button>
              )
            })}
            {!mentionFiles.length && (
              <div className="composer-command-empty">
                {projectFiles?.root === workspaceFolder ? 'No matching files' : 'Listing files…'}
              </div>
            )}
          </div>
        ) : undefined
      }
      inputAriaControls={
        commandMatch ? 'composer-command-menu' : fileMention ? 'composer-file-menu' : undefined
      }
      inputAriaExpanded={Boolean(commandMatch || fileMention)}
      inputAriaActiveDescendant={
        commandMatch && visibleCommands[commandIndex]
          ? `composer-command-${visibleCommands[commandIndex].id}`
          : fileMention && mentionFiles[fileIndex]
            ? `composer-file-${fileIndex}`
            : undefined
      }
      attachmentTray={
        attachedImages.length || attachedContext.length || attachmentError ? (
          <div className="composer-attachments" aria-label="Message attachments">
            {attachedContext.map((attachment) =>
              isPastedTextAttachment(attachment) ? (
                <PastedTextAttachmentCard
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => onRemoveContextAttachment(attachment.id)}
                  onInsert={editingMessageId ? undefined : () => onInsertPastedText(attachment.id)}
                />
              ) : isReviewCommentAttachment(attachment) ? (
                <div
                  className="composer-context-attachment composer-review-comment"
                  key={attachment.id}
                  title={`${attachment.path}:${reviewCommentLineLabel(attachment.startLine, attachment.endLine)}\n${attachment.comment}`}
                >
                  <MessageSquareText size={15} aria-hidden="true" />
                  <span>
                    <strong>{attachment.name}</strong> {attachment.comment}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveContextAttachment(attachment.id)}
                    title={`Remove comment on ${attachment.name}`}
                    aria-label={`Remove comment on ${attachment.name}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <div
                  className="composer-context-attachment"
                  key={attachment.id}
                  title={attachment.relativePath}
                >
                  {attachment.kind === 'folder' ? (
                    <FolderOpen size={15} aria-hidden="true" />
                  ) : (
                    <FileText size={15} aria-hidden="true" />
                  )}
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveContextAttachment(attachment.id)}
                    title={`Remove ${attachment.name}`}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            )}
            {attachedImages.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <ImageAttachmentPreview image={image} className="composer-image-preview" />
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => onRemoveImage(image.id)}
                  title={`Remove ${image.name}`}
                  aria-label={`Remove ${image.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {attachmentError && (
              <span className="composer-attachment-error">{attachmentError}</span>
            )}
          </div>
        ) : undefined
      }
      floatingAccessory={
        <ScrollToBottomButton visible={showScrollToBottom} onClick={onScrollToBottom} />
      }
      sendDisabled={
        (!inputValue.trim() && !attachedImages.length && !attachedContext.length) ||
        Boolean(commandMatch) ||
        Boolean(editingMessageId) ||
        isStopping
      }
      sendButtonClassName={isStopping ? 'is-stopping' : ''}
      sendTitle={
        isLoading
          ? 'Add message to queue'
          : researchSelected
            ? 'Start research report'
            : planSelected
              ? 'Start Plan mode'
              : 'Send message'
      }
      toolbarLeft={
        <>
          <div
            className="features-menu-container composer-add-menu-container"
            ref={featuresMenuRef}
          >
            <input
              ref={imageInputRef}
              className="composer-image-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const files = Array.from(event.target.files || [])
                event.target.value = ''
                if (files.length) onAddImageFiles(files)
              }}
            />
            <button
              type="button"
              className={`input-plus-button ${isFeaturesMenuOpen ? 'menu-open' : ''}`}
              onClick={onToggleFeaturesMenu}
              title="Add an attachment, project context, or agent behavior"
              aria-label="Add an attachment, project context, or agent behavior"
              aria-haspopup="menu"
              aria-expanded={isFeaturesMenuOpen}
              aria-controls={isFeaturesMenuOpen ? 'composer-features-menu' : undefined}
            >
              <Plus size={18} strokeWidth={1.8} />
            </button>

            {isFeaturesMenuOpen && (
              <div
                className="features-menu features-menu-organized"
                id="composer-features-menu"
                role="menu"
                aria-label="Add to message"
              >
                <section className="features-menu-section" role="group" aria-label="Add">
                  <div className="features-menu-section-label">Add</div>
                  <FeatureMenuAction
                    label="Files and folders"
                    description="Attach files or a folder from the current project"
                    icon={<Paperclip size={16} />}
                    onClick={() => runFeatureAction(onAddContextAttachments)}
                    disabled={!workspaceFolder || Boolean(editingMessageId)}
                    unavailableReason={
                      editingMessageId
                        ? 'Attachments cannot be changed while editing a message'
                        : !workspaceFolder
                          ? 'Open a project before attaching files or folders'
                          : undefined
                    }
                  />
                  <FeatureMenuAction
                    label="Image from computer"
                    description="Attach a PNG, JPEG, WebP, or GIF to this message"
                    icon={<ImagePlus size={16} />}
                    onClick={() =>
                      runFeatureAction(() => {
                        imageInputRef.current?.click()
                      })
                    }
                    disabled={!visionAvailable || Boolean(editingMessageId)}
                    unavailableReason={
                      editingMessageId
                        ? 'Images cannot be changed while editing a message'
                        : visionUnavailableReason
                    }
                  />
                </section>

                <section
                  className="features-menu-section"
                  role="group"
                  aria-label="Project context"
                >
                  <div className="features-menu-section-label">Project context</div>
                  <FeatureMenuAction
                    label={workspaceFolder ? 'Change project folder' : 'Open project folder'}
                    description="Choose the files SideKick can read and change"
                    icon={<FolderOpen size={16} />}
                    onClick={() => runFeatureAction(onOpenWorkspace)}
                    selected={Boolean(workspaceFolder)}
                  />
                  {workspaceFolder && (
                    <FeatureMenuAction
                      label="Shared project notes"
                      description="Edit SideKick notes included in every chat for this folder"
                      icon={<StickyNote size={16} />}
                      onClick={() => runFeatureAction(onOpenWorkspaceMemory)}
                      disabled={!workspaceMemoryAvailable}
                      unavailableReason={workspaceMemoryUnavailableReason}
                    />
                  )}
                  {workspaceFolder && (
                    <FeatureMenuStatus
                      label="Instruction files (AGENTS.md)"
                      description={instructionStatusDescription}
                      title={instructionStatusTitle}
                      error={Boolean(instructionError)}
                    />
                  )}
                </section>

                <section className="features-menu-section" role="group" aria-label="Agent behavior">
                  <div className="features-menu-section-label">Agent behavior</div>
                  <FeatureMenuAction
                    label="Ongoing goal"
                    description="Keep SideKick working toward an objective across messages"
                    icon={<Target size={16} />}
                    onClick={() => runFeatureAction(onToggleGoal)}
                    disabled={!goalAvailable && !goalArmed}
                    unavailableReason={goalUnavailableReason}
                    selected={goalArmed}
                  />
                  <FeatureMenuAction
                    label="Plan first"
                    description="Review a plan before SideKick changes project files"
                    icon={<ListChecks size={16} />}
                    onClick={() => runFeatureAction(onTogglePlan)}
                    disabled={!planAvailable}
                    unavailableReason={planUnavailableReason}
                    selected={planSelected}
                  />
                  <FeatureMenuAction
                    label="Research report"
                    description="Search, cross-check, and cite web sources"
                    icon={<Microscope size={16} />}
                    onClick={() => runFeatureAction(onToggleResearch)}
                    disabled={!researchAvailable}
                    unavailableReason={researchUnavailableReason}
                    selected={researchSelected}
                  />
                  {thinkingAvailable && (
                    <FeatureMenuAction
                      label="Model thinking"
                      description="Let the selected model use its reasoning mode"
                      icon={<Brain size={16} />}
                      onClick={() => runFeatureAction(onToggleThinking)}
                      selected={thinkingEnabled}
                    />
                  )}
                </section>
              </div>
            )}
          </div>

          {thinkingAvailable && thinkingEnabled && (
            <button className="composer-status composer-status-active" onClick={onToggleThinking}>
              <Brain size={13} />
              Thinking
            </button>
          )}
        </>
      }
      toolbarRight={
        <>
          <DictationButton inputRef={inputRef} onInputChange={onInputChange} />
          <ChatModelPicker
            selectedModelId={selectedModel}
            models={pinnedModels}
            isOpen={isModelMenuOpen}
            containerRef={modelMenuRef}
            onToggle={onToggleModelMenu}
            onModelChange={onModelChange}
            onManageModels={onOpenModelSearch}
          />
          {isLoading && (
            <button
              className={`stop-button ${isStopping ? 'is-stopping' : ''}`}
              onClick={onStopGeneration}
              disabled={isStopping}
              title={isStopping ? 'Stopping...' : 'Stop generation'}
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
        </>
      }
    />
  )
}
