import React from 'react'
import {
  Brain,
  Check,
  Command,
  FileText,
  FolderOpen,
  ListChecks,
  Loader2,
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
import { ConversationGoalBar } from './ConversationGoalBar'
import { QueuedMessageTray } from './QueuedMessageTray'
import type { PendingRunMessageItem } from '../hooks/useConversationRun'
import type { MessageImageAttachment } from '../../../shared/messageImages'
import type { MessageContextAttachment } from '../../../shared/messageContextAttachments'
import { clipboardImageFiles } from '../utils/messageImageAttachments'
import { ImageAttachmentPreview } from './ImageAttachmentPreview'
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
  onRemoveImage: (id: string) => void
  onRemoveContextAttachment: (id: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSendMessage: () => void
  onStopGeneration: () => void
  onToggleResearch: () => void
  onTogglePlan: () => void
  onPlanModelChange: (modelId: string) => void
  onOpenGoal: () => void
  onEditGoal: () => void
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
  onRemoveImage,
  onRemoveContextAttachment,
  onKeyDown,
  onSendMessage,
  onStopGeneration,
  onToggleResearch,
  onTogglePlan,
  onPlanModelChange,
  onOpenGoal,
  onEditGoal,
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
  showScrollToBottom = false,
  onScrollToBottom = () => undefined
}: ChatInputProps) {
  const imageInputRef = React.useRef<HTMLInputElement>(null)
  const [commandIndex, setCommandIndex] = React.useState(0)
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
        label: 'Ongoing goal',
        hint: 'Keep working toward an objective across messages',
        keywords: 'goal task objective',
        disabled: !goalAvailable,
        run: onOpenGoal
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
      goalAvailable,
      onOpenGoal,
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
  const visibleCommands = commandMatch
    ? commands.filter((command) =>
        `${command.id} ${command.label} ${command.keywords}`.toLowerCase().includes(commandQuery)
      )
    : []

  React.useEffect(() => setCommandIndex(0), [commandQuery])

  const runCommand = (index: number): void => {
    const command = visibleCommands[index]
    if (!command || command.disabled) return
    onInputChange('')
    command.run()
  }

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      onInputChange('/')
      setCommandIndex(0)
      return
    }
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
    if (commandMatch && event.key === 'Escape') {
      event.preventDefault()
      onInputChange('')
      return
    }
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
        goal?.status === 'active'
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
            onEdit={onEditGoal}
            onPause={onPauseGoal}
            onResume={onResumeGoal}
            onClear={onClearGoal}
          />
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
      onChange={onInputChange}
      onKeyDown={handleComposerKeyDown}
      onPaste={(event) => {
        const files = clipboardImageFiles(event.clipboardData.items)
        if (!files.length) return
        event.preventDefault()
        onAddImageFiles(files)
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
        ) : undefined
      }
      inputAriaControls={commandMatch ? 'composer-command-menu' : undefined}
      inputAriaExpanded={Boolean(commandMatch)}
      inputAriaActiveDescendant={
        commandMatch && visibleCommands[commandIndex]
          ? `composer-command-${visibleCommands[commandIndex].id}`
          : undefined
      }
      attachmentTray={
        attachedImages.length || attachedContext.length || attachmentError ? (
          <div className="composer-attachments" aria-label="Message attachments">
            {attachedContext.map((attachment) => (
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
            ))}
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
                    onClick={() => runFeatureAction(onOpenGoal)}
                    disabled={!goalAvailable}
                    unavailableReason={goalUnavailableReason}
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
