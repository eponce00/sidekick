import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Clock3,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  FolderTree,
  GitCompareArrows,
  History,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  RefreshCw,
  Search,
  Square
} from 'lucide-react'
import type {
  CollaborationAgentSession,
  CollaborationAgentSessionMessage,
  CollaborationEvent,
  CollaborationMission,
  CollaborationParticipant,
  CollaborationParticipantRun
} from '../../../shared/collaboration'
import type { CheckpointHistoryItem, HistoryStatus } from '../../../shared/checkpointTitles'
import type { Message } from '../types/chat.types'
import type { PinnedModel } from '../types/models.types'
import {
  buildGroupFileTree,
  filterGroupWorkspaceFiles,
  normalizeGroupWorkspacePath
} from '../utils/groupWorkspaceFiles'
import { projectGroupAgentConversation } from '../utils/groupAgentConversation'
import { groupAgentContextTokens } from '../utils/groupAgentContext'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { pinnedModelForProviderTarget } from '../utils/providerTarget'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { ProviderIcon } from './ProviderIcon'
import { MessageItem } from './MessageItem'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import ContextIndicator from './ContextIndicator'
import './GroupWorkspacePanel.css'

type GroupWorkspaceTab = 'work' | 'files' | 'history'

interface GroupWorkspacePanelProps {
  open: boolean
  participants: CollaborationParticipant[]
  allParticipants?: CollaborationParticipant[]
  agentSession: CollaborationAgentSession
  pinnedModels: PinnedModel[]
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  participantRuns: CollaborationParticipantRun[]
  mission: CollaborationMission | null
  events: CollaborationEvent[]
  historyVersion: number
  onClose: () => void
  onOpenFull?: () => void
  expanded?: boolean
}

function initials(label: string): string {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

function fileName(path: string): string {
  const clean = path.endsWith('/') ? path.slice(0, -1) : path
  return clean.split('/').pop() || clean
}

function absoluteWorkspacePath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const normalizedRelative = relativePath.replaceAll('/', separator)
  return `${root.replace(/[\\/]$/, '')}${separator}${normalizedRelative}`
}

function runLabel(run: CollaborationParticipantRun | undefined, requested: boolean): string {
  if (!run) return requested ? 'Queued' : 'Ready'
  if (run.currentActivity) return run.currentActivity
  if (run.status === 'waiting') return 'Caught up'
  if (run.status === 'queued') return 'New messages waiting'
  return run.status.replaceAll('_', ' ')
}

function truncateDiff(diff: string): string {
  const limit = 30_000
  if (diff.length <= limit) return diff
  return `${diff.slice(0, limit)}\n\n[Diff truncated in sidebar]`
}

export function GroupWorkspacePanel({
  open,
  participants,
  allParticipants = participants,
  agentSession,
  pinnedModels,
  autoCompactEnabled = true,
  autoCompactThreshold = 0.8,
  participantRuns,
  mission,
  events,
  historyVersion,
  onClose,
  onOpenFull,
  expanded = false
}: GroupWorkspacePanelProps): React.JSX.Element | null {
  const [selectedParticipantId, setSelectedParticipantId] = useState('')
  const [activeTab, setActiveTab] = useState<GroupWorkspaceTab>('work')
  const [sessionMessages, setSessionMessages] = useState<CollaborationAgentSessionMessage[]>([])
  const [sessionLoading, setSessionLoading] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [fileQuery, setFileQuery] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [fileRefreshVersion, setFileRefreshVersion] = useState(0)
  const [checkpoints, setCheckpoints] = useState<CheckpointHistoryItem[]>([])
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [expandedCheckpoint, setExpandedCheckpoint] = useState<string | null>(null)
  const [checkpointDiff, setCheckpointDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [stoppingParticipantId, setStoppingParticipantId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants]
  )
  const runByParticipantId = useMemo(
    () => new Map(participantRuns.map((run) => [run.participantId, run])),
    [participantRuns]
  )
  const selectedParticipant = participantById.get(selectedParticipantId) || participants[0] || null
  const selectedRun = selectedParticipant
    ? runByParticipantId.get(selectedParticipant.id)
    : undefined
  const selectedProjectFolder = selectedParticipant?.projectFolder || ''
  const selectedProjectId = selectedParticipant?.id || ''
  const selectedRequested = Boolean(
    selectedParticipant && mission?.requestedParticipantIds.includes(selectedParticipant.id)
  )
  const latestEventSeq = events.at(-1)?.seq
  const selectedPinnedModel = selectedParticipant
    ? pinnedModelForProviderTarget(pinnedModels, selectedParticipant.providerTarget)
    : undefined
  const contextTokens = useMemo(() => groupAgentContextTokens(sessionMessages), [sessionMessages])
  const contextMaxTokens = selectedParticipant
    ? selectedParticipant.providerTarget.contextLength || selectedPinnedModel?.contextLength || 0
    : 0

  useEffect(() => {
    if (!participants.length) {
      setSelectedParticipantId('')
      return
    }
    if (!participants.some((participant) => participant.id === selectedParticipantId)) {
      setSelectedParticipantId(participants[0].id)
    }
  }, [participants, selectedParticipantId])

  useEffect(() => {
    setFiles([])
    setFilesError('')
    setFileQuery('')
    setExpandedFolders(new Set())
    setCheckpoints([])
    setHistoryStatus(null)
    setHistoryError('')
    setExpandedCheckpoint(null)
    setCheckpointDiff('')
    setActionError('')
  }, [selectedParticipant?.id])

  useEffect(() => {
    if (!open || activeTab !== 'work') return
    let cancelled = false
    setSessionLoading(true)
    window.api.collaboration
      .listAgentSessionMessages(agentSession.id)
      .then((messages) => {
        if (!cancelled) setSessionMessages(messages)
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, agentSession.id, agentSession.updatedAt, latestEventSeq, open])

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.api.workspace.onFilesChanged(() => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => setFileRefreshVersion((version) => version + 1), 200)
    })
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!open || activeTab !== 'files' || !selectedProjectFolder) return
    let cancelled = false
    setFilesLoading(true)
    setFilesError('')
    window.api.workspace
      .listFiles(selectedProjectFolder)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setFiles([])
          setFilesError(result.error || 'Files could not be loaded.')
          return
        }
        const normalized = result.files.map(normalizeGroupWorkspacePath)
        setFiles(normalized)
        setExpandedFolders(
          new Set(
            normalized.filter(
              (entry) => entry.endsWith('/') && entry.slice(0, -1).split('/').length === 1
            )
          )
        )
      })
      .catch((error) => {
        if (!cancelled) setFilesError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, fileRefreshVersion, open, selectedProjectFolder])

  useEffect(() => {
    if (!open || activeTab !== 'history' || !selectedProjectFolder) return
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError('')
    window.api.workspace
      .listCheckpoints(selectedProjectFolder)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setCheckpoints([])
          setHistoryStatus(null)
          setHistoryError(result.error || 'History could not be loaded.')
          return
        }
        setCheckpoints(result.checkpoints)
        setHistoryStatus(result.status ?? null)
      })
      .catch((error) => {
        if (!cancelled) setHistoryError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, historyVersion, open, selectedProjectFolder])

  const fileTree = useMemo(() => buildGroupFileTree(files), [files])
  const filteredFiles = useMemo(
    () => filterGroupWorkspaceFiles(fileTree.files, fileQuery),
    [fileQuery, fileTree.files]
  )
  const participantEvents = useMemo(
    () =>
      selectedProjectId
        ? events.filter((event) => event.actorParticipantId === selectedProjectId)
        : [],
    [events, selectedProjectId]
  )
  const messagesSent = participantEvents.filter((event) =>
    ['agent_message', 'peer_message'].includes(event.kind)
  ).length
  const toolsUsed = participantEvents.filter((event) => event.kind === 'tool_call').length
  const projection = useMemo(
    () =>
      selectedParticipant
        ? projectGroupAgentConversation({
            participant: selectedParticipant,
            participants: allParticipants,
            events,
            sessionMessages
          })
        : { messages: [], activities: [] },
    [allParticipants, events, selectedParticipant, sessionMessages]
  )
  const isBusy = Boolean(selectedRun && ['queued', 'working'].includes(selectedRun.status))
  const visibleMessages = useMemo<Message[]>(() => {
    if (!isBusy) return projection.messages
    const last = projection.messages.at(-1)
    const hasRunningTool = last?.segments?.some(
      (segment) => segment.type === 'tool' && segment.tool?.status === 'running'
    )
    if (hasRunningTool) return projection.messages
    return [
      ...projection.messages,
      {
        id: `working-${selectedRun?.missionId || agentSession.id}`,
        role: 'agent',
        content: '',
        timestamp: selectedRun?.startedAt ?? selectedRun?.updatedAt ?? Date.now()
      }
    ]
  }, [agentSession.id, isBusy, projection.messages, selectedRun])
  const latestVisibleMessage = visibleMessages.at(-1)
  const transcriptChangeKey = `${visibleMessages.length}:${latestVisibleMessage?.id || ''}:${latestVisibleMessage?.content.length || 0}:${latestVisibleMessage?.segments?.length || 0}`
  const { showScrollToBottom, scrollToBottom } = useAutoScroll(
    transcriptEndRef,
    transcriptRef,
    visibleMessages,
    'auto',
    `${agentSession.id}:${activeTab}`,
    transcriptChangeKey
  )

  const copyMessage = useCallback(async (message: Message): Promise<void> => {
    const result = await window.api.clipboard.writeText(messageTextForClipboard(message))
    if (!result.success) return
    setCopiedMessageId(message.id)
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    copyTimeoutRef.current = setTimeout(() => {
      setCopiedMessageId(null)
      copyTimeoutRef.current = null
    }, 2_000)
  }, [])

  const stopSelectedAgent = useCallback(async (): Promise<void> => {
    if (!selectedParticipant || !selectedRun || !isBusy || stoppingParticipantId) return
    setStoppingParticipantId(selectedParticipant.id)
    setActionError('')
    try {
      await window.api.collaboration.stopParticipant(selectedRun.missionId, selectedParticipant.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setStoppingParticipantId(null)
    }
  }, [isBusy, selectedParticipant, selectedRun, stoppingParticipantId])

  const openDiff = useCallback(
    async (checkpoint: CheckpointHistoryItem): Promise<void> => {
      if (!selectedProjectFolder) return
      if (expandedCheckpoint === checkpoint.hash) {
        setExpandedCheckpoint(null)
        setCheckpointDiff('')
        return
      }
      setExpandedCheckpoint(checkpoint.hash)
      setCheckpointDiff('')
      setDiffLoading(true)
      try {
        const result = await window.api.workspace.getCheckpointDiff(
          selectedProjectFolder,
          checkpoint.hash
        )
        setCheckpointDiff(
          result.ok
            ? truncateDiff(result.diff || 'No textual diff recorded.')
            : result.error || 'Diff unavailable.'
        )
      } catch (error) {
        setCheckpointDiff(error instanceof Error ? error.message : String(error))
      } finally {
        setDiffLoading(false)
      }
    },
    [expandedCheckpoint, selectedProjectFolder]
  )

  const renderTree = (parent: string, depth: number): React.ReactNode =>
    (fileTree.childrenByFolder.get(parent) || []).map((entry) => {
      const directory = entry.endsWith('/')
      const expanded = expandedFolders.has(entry)
      const name = fileName(entry)
      return (
        <div key={entry}>
          <div className="group-workspace-file-row">
            <button
              type="button"
              className="group-workspace-file-main"
              style={{ paddingLeft: `${10 + depth * 13}px` }}
              title={entry}
              onClick={() => {
                if (directory) {
                  setExpandedFolders((current) => {
                    const next = new Set(current)
                    if (next.has(entry)) next.delete(entry)
                    else next.add(entry)
                    return next
                  })
                } else if (selectedParticipant) {
                  void window.api.workspace.openFile(
                    absoluteWorkspacePath(selectedParticipant.projectFolder, entry),
                    selectedParticipant.projectFolder
                  )
                }
              }}
            >
              <span className="group-workspace-file-chevron">
                {directory && <ChevronRight size={11} className={expanded ? 'open' : ''} />}
              </span>
              {directory ? <Folder size={14} /> : <File size={14} />}
              <span>{name}</span>
            </button>
            {!directory && selectedParticipant && (
              <button
                type="button"
                className="group-workspace-file-reveal"
                title={`Show ${name} in folder`}
                aria-label={`Show ${entry} in folder`}
                onClick={() =>
                  void window.api.workspace.revealFile(
                    absoluteWorkspacePath(selectedParticipant.projectFolder, entry),
                    selectedParticipant.projectFolder
                  )
                }
              >
                <FolderOpen size={12} />
              </button>
            )}
          </div>
          {directory && expanded && renderTree(entry, depth + 1)}
        </div>
      )
    })

  if (!open) return null

  return (
    <aside
      className={`group-workspace-panel group-agent-session-pane ${expanded ? 'expanded' : ''}`}
      aria-label={`${selectedParticipant?.label || 'Agent'} session`}
    >
      <div className="group-workspace-header">
        <span className="group-agent-pane-heading">
          <span className={`group-project-state ${selectedRun?.status || 'waiting'}`} />
          <span>
            <strong>{selectedParticipant?.label || 'Project agent'}</strong>
            <small>{selectedParticipant?.projectName || 'Project'}</small>
          </span>
        </span>
        <span className="group-agent-pane-actions">
          {selectedParticipant && (
            <span className="group-agent-pane-context">
              <ContextIndicator
                currentTokens={contextTokens}
                maxTokens={contextMaxTokens}
                selectedModel={selectedPinnedModel?.id || selectedParticipant.providerTarget.model}
                model={selectedPinnedModel}
                autoCompactEnabled={autoCompactEnabled}
                autoCompactThreshold={autoCompactThreshold}
              />
            </span>
          )}
          {isBusy && selectedParticipant && (
            <button
              type="button"
              className="group-agent-pane-stop"
              onClick={() => void stopSelectedAgent()}
              disabled={stoppingParticipantId !== null}
              title={
                stoppingParticipantId === selectedParticipant.id
                  ? 'Stopping…'
                  : `Stop ${selectedParticipant.label}`
              }
              aria-label={`Stop ${selectedParticipant.label}`}
            >
              <Square size={13} fill="currentColor" />
            </button>
          )}
          {onOpenFull && !expanded && (
            <button
              type="button"
              onClick={onOpenFull}
              title={`Open ${selectedParticipant?.label || 'agent'} conversation`}
              aria-label={`Open ${selectedParticipant?.label || 'agent'} conversation`}
            >
              <ExternalLink size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={expanded ? 'Back to group chat' : 'Close agent sessions'}
            aria-label={expanded ? 'Back to group chat' : 'Close agent sessions'}
          >
            <PanelRightClose size={15} />
          </button>
        </span>
      </div>

      {actionError && <div className="group-workspace-error">{actionError}</div>}

      {participants.length > 1 && (
        <div className="group-project-switcher" aria-label="Select project agent">
          {participants.map((participant) => {
            const run = runByParticipantId.get(participant.id)
            const requested = Boolean(mission?.requestedParticipantIds.includes(participant.id))
            return (
              <button
                type="button"
                key={participant.id}
                className={participant.id === selectedParticipant?.id ? 'active' : ''}
                onClick={() => setSelectedParticipantId(participant.id)}
                title={`Show ${participant.label} · ${participant.projectName}`}
              >
                <span className="group-project-avatar">{initials(participant.projectName)}</span>
                <span className="group-project-copy">
                  <strong>{participant.projectName}</strong>
                  <small>{runLabel(run, requested)}</small>
                </span>
                <span
                  className={`group-project-state ${run?.status || (requested ? 'queued' : 'waiting')}`}
                />
              </button>
            )
          })}
        </div>
      )}

      <div className="group-workspace-tabs" role="tablist" aria-label="Project information">
        <button
          type="button"
          className={activeTab === 'work' ? 'active' : ''}
          onClick={() => setActiveTab('work')}
          role="tab"
          aria-selected={activeTab === 'work'}
          title="Agent conversation and tool activity"
        >
          <MessageSquare size={14} /> Work
        </button>
        <button
          type="button"
          className={activeTab === 'files' ? 'active' : ''}
          onClick={() => setActiveTab('files')}
          role="tab"
          aria-selected={activeTab === 'files'}
          title="Project files"
        >
          <FolderTree size={14} /> Files
        </button>
        <button
          type="button"
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
          role="tab"
          aria-selected={activeTab === 'history'}
          title="SideKick History checkpoints"
        >
          <History size={14} /> History
        </button>
      </div>

      <div className={`group-workspace-content ${activeTab === 'work' ? 'is-work' : ''}`}>
        {!selectedParticipant ? (
          <div className="group-workspace-empty">No active project agents.</div>
        ) : activeTab === 'work' ? (
          <div className="group-agent-work">
            <div className="group-agent-work-summary">
              <ProviderIcon provider={selectedParticipant.providerTarget.providerKind} size={13} />
              <span title={selectedParticipant.providerTarget.model}>
                {selectedParticipant.providerTarget.model}
              </span>
              <em>{runLabel(selectedRun, selectedRequested)}</em>
            </div>
            {sessionLoading && visibleMessages.length === 0 ? (
              <div className="group-workspace-empty">
                <LoaderCircle size={15} className="spin" /> Loading private session…
              </div>
            ) : visibleMessages.length ? (
              <div className="group-agent-transcript-shell">
                <div
                  className="group-agent-transcript messages-container"
                  ref={transcriptRef}
                  aria-label={`${selectedParticipant.label} conversation`}
                >
                  {visibleMessages.map((message, index) => (
                    <MessageItem
                      key={message.id}
                      message={message}
                      index={index}
                      isLoading={
                        isBusy && index === visibleMessages.length - 1 && message.role === 'agent'
                      }
                      expandedThinking={expandedThinking}
                      editingMessageId={null}
                      editingGeometry={null}
                      editingContent=""
                      copiedMessageId={copiedMessageId}
                      readOnly
                      onToggleThinking={(id) =>
                        setExpandedThinking((current) => {
                          const next = new Set(current)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                      onHandleArtifactResult={() => undefined}
                      onEditMessage={() => undefined}
                      onCancelEditMessage={() => undefined}
                      onConfirmEditMessage={() => undefined}
                      onCopyMessage={(target) => void copyMessage(target)}
                      onRetryMessage={() => undefined}
                      onSetEditingContent={() => undefined}
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
                    />
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
                <div className="group-agent-scroll-button">
                  <ScrollToBottomButton visible={showScrollToBottom} onClick={scrollToBottom} />
                </div>
              </div>
            ) : (
              <div className="group-workspace-empty">
                This private session will show reasoning outputs, tools, and project work when the
                agent is addressed.
              </div>
            )}
            <div className="group-agent-work-footer">
              <span>
                {messagesSent} shared messages · {toolsUsed} tools
              </span>
              <button
                type="button"
                onClick={() =>
                  void window.api.workspace.openFolder(
                    selectedParticipant.projectFolder,
                    selectedParticipant.projectFolder
                  )
                }
                title={`Open ${selectedParticipant.projectName} in the system file manager`}
              >
                <FolderOpen size={12} /> Open folder
              </button>
            </div>
          </div>
        ) : activeTab === 'files' ? (
          <div className="group-workspace-files">
            <div className="group-workspace-tool-row">
              <label className="group-workspace-search">
                <Search size={13} />
                <input
                  value={fileQuery}
                  onChange={(event) => setFileQuery(event.target.value)}
                  placeholder="Filter files"
                  aria-label="Filter project files"
                />
              </label>
              <button
                type="button"
                onClick={() => setFileRefreshVersion((version) => version + 1)}
                title="Refresh files"
              >
                <RefreshCw size={13} className={filesLoading ? 'spin' : ''} />
              </button>
            </div>
            <div className="group-workspace-root-label">
              <Folder size={13} /> {selectedParticipant.projectName}
            </div>
            {filesError ? (
              <div className="group-workspace-error">{filesError}</div>
            ) : filesLoading && files.length === 0 ? (
              <div className="group-workspace-empty">
                <LoaderCircle size={15} className="spin" /> Loading files…
              </div>
            ) : fileQuery.trim() ? (
              filteredFiles.length ? (
                <div className="group-workspace-flat-files">
                  {filteredFiles.map((entry) => (
                    <button
                      type="button"
                      key={entry}
                      onClick={() =>
                        void window.api.workspace.openFile(
                          absoluteWorkspacePath(selectedParticipant.projectFolder, entry),
                          selectedParticipant.projectFolder
                        )
                      }
                      title={entry}
                    >
                      <File size={13} />
                      <span>
                        <strong>{fileName(entry)}</strong>
                        <small>{entry}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="group-workspace-empty">No files match “{fileQuery}”.</div>
              )
            ) : files.length ? (
              <div className="group-workspace-file-tree">{renderTree('', 0)}</div>
            ) : (
              <div className="group-workspace-empty">This project has no visible files.</div>
            )}
          </div>
        ) : (
          <div className="group-workspace-history">
            <p className="group-history-readonly">
              History is view-only here so restoring one project cannot invalidate the shared group
              timeline. Open a normal project chat when you need to restore a checkpoint.
            </p>
            {historyError ? (
              <div className="group-workspace-error">{historyError}</div>
            ) : historyLoading ? (
              <div className="group-workspace-empty">
                <LoaderCircle size={15} className="spin" /> Loading history…
              </div>
            ) : checkpoints.length ? (
              <div className="group-history-list">
                {checkpoints.map((checkpoint, index) => {
                  const current = checkpoint.hash === historyStatus?.appliedHash
                  const expanded = expandedCheckpoint === checkpoint.hash
                  return (
                    <div key={checkpoint.hash} className="group-history-item">
                      <button
                        type="button"
                        onClick={() => void openDiff(checkpoint)}
                        title={expanded ? 'Collapse checkpoint changes' : 'Show checkpoint changes'}
                      >
                        <span className="group-history-marker" />
                        <span className="group-history-copy">
                          <span className="group-history-labels">
                            {current && <em>Current</em>}
                            {index === 0 && !current && <em>Latest</em>}
                            <strong>{checkpoint.message}</strong>
                          </span>
                          <small>
                            <Clock3 size={11} /> {new Date(checkpoint.timestamp).toLocaleString()}
                            {checkpoint.changeCount !== undefined
                              ? ` · ${checkpoint.changeCount} ${checkpoint.changeCount === 1 ? 'file' : 'files'}`
                              : ''}
                          </small>
                        </span>
                        <GitCompareArrows size={13} />
                      </button>
                      {expanded && (
                        <pre className="group-history-diff">
                          {diffLoading ? 'Loading diff…' : checkpointDiff}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="group-workspace-empty">
                No checkpoints yet. Group agents create one after changing project files.
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
