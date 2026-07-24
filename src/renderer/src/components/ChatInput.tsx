import React from 'react'
import {
  Brain,
  Check,
  FileText,
  FolderOpen,
  ListChecks,
  Loader2,
  Microscope,
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

interface ChatInputProps {
  inputValue: string
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
      onKeyDown={onKeyDown}
      onSend={onSendMessage}
      floatingAccessory={
        <ScrollToBottomButton visible={showScrollToBottom} onClick={onScrollToBottom} />
      }
      sendDisabled={!inputValue.trim() || Boolean(editingMessageId) || isStopping}
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
          <div className="features-menu-container" ref={featuresMenuRef}>
            <button
              className={`input-plus-button ${isFeaturesMenuOpen ? 'menu-open' : ''}`}
              onClick={onToggleFeaturesMenu}
              title="Add context or change agent mode"
              aria-label="Add context or change agent mode"
            >
              <Plus size={18} strokeWidth={1.8} />
            </button>

            {isFeaturesMenuOpen && (
              <div className="features-menu">
                <button
                  className="features-menu-item"
                  onClick={onOpenGoal}
                  disabled={!goalAvailable}
                  title={goalUnavailableReason}
                >
                  <span className="features-menu-item-icon">
                    <Target size={16} />
                  </span>
                  <span className="features-menu-item-label">Persistent goal</span>
                </button>
                <button
                  className="features-menu-item"
                  onClick={onTogglePlan}
                  disabled={!planAvailable}
                  title={planUnavailableReason}
                >
                  <span className="features-menu-item-icon">
                    <ListChecks size={16} />
                  </span>
                  <span className="features-menu-item-label">Plan first</span>
                  {planSelected && (
                    <span className="features-menu-item-check">
                      <Check size={15} />
                    </span>
                  )}
                </button>
                <button
                  className="features-menu-item"
                  onClick={onToggleResearch}
                  disabled={!researchAvailable}
                  title={researchUnavailableReason}
                >
                  <span className="features-menu-item-icon">
                    <Microscope size={16} />
                  </span>
                  <span className="features-menu-item-label">Research report</span>
                  {researchSelected && (
                    <span className="features-menu-item-check">
                      <Check size={15} />
                    </span>
                  )}
                </button>
                <button className="features-menu-item" onClick={onOpenWorkspace}>
                  <span className="features-menu-item-icon">
                    <FolderOpen size={16} />
                  </span>
                  <span className="features-menu-item-label">
                    {workspaceFolder ? 'Change project folder' : 'Open project folder'}
                  </span>
                  {workspaceFolder && (
                    <span className="features-menu-item-check">
                      <Check size={15} />
                    </span>
                  )}
                </button>
                {workspaceFolder && (
                  <button className="features-menu-item" onClick={onOpenWorkspaceMemory}>
                    <span className="features-menu-item-icon">
                      <Brain size={16} />
                    </span>
                    <span className="features-menu-item-label">Project memory</span>
                  </button>
                )}
                {workspaceFolder && (
                  <div
                    className={`features-menu-item features-menu-info ${instructionError ? 'is-error' : ''}`}
                    title={
                      instructionError ||
                      (instructionSources.length
                        ? `${instructionSources.join('\n')}${instructionsTruncated ? '\nSome instructions were truncated' : ''}`
                        : 'No project instruction files found')
                    }
                  >
                    <span className="features-menu-item-icon">
                      <FileText size={16} />
                    </span>
                    <span className="features-menu-item-label">Project instructions</span>
                  </div>
                )}
                {thinkingAvailable && (
                  <button className="features-menu-item" onClick={onToggleThinking}>
                    <span className="features-menu-item-icon">
                      <Brain size={16} />
                    </span>
                    <span className="features-menu-item-label">Thinking</span>
                    {thinkingEnabled && (
                      <span className="features-menu-item-check">
                        <Check size={15} />
                      </span>
                    )}
                  </button>
                )}
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
