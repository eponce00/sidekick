import {
  useCallback,
  useState,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Loader2,
  MoreHorizontal,
  ChevronRight,
  File,
  Folder,
  X,
  History,
  FolderTree,
  MonitorUp,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import ConfirmDialog from './ConfirmDialog'
import type { TodoItem } from '../../../shared/types'
import type { PinnedModel } from '../types/models.types'
import {
  CHECKPOINT_TITLE_VERSION,
  type CheckpointHistoryItem,
  type HistoryConflict
} from '../../../shared/checkpointTitles'
import { workspacePermissionOperation } from '../../../shared/permissions'
import { authorizeCheckpointMutation } from '../utils/checkpointAuthorization'
import { useCheckpointTitleBackfill } from '../hooks/useCheckpointTitleBackfill'
import BrowserActivityPanel from './BrowserActivityPanel'
import { EMPTY_BROWSER_ACTIVITY, type BrowserActivityState } from '../utils/browserActivity'
import {
  ACTIVITY_PANEL_DEFAULT_WIDTH,
  ACTIVITY_PANEL_MIN_WIDTH,
  ACTIVITY_PANEL_WIDE_WIDTH,
  activityPanelMaximumWidth,
  clampActivityPanelWidth,
  storedActivityPanelWidth
} from '../utils/activityPanelLayout'
import './ActivityPanel.css'

type ActivityTab = 'checkpoints' | 'files' | 'browser'

function storedActivityTab(): ActivityTab {
  const value = window.localStorage.getItem('activityPanelTab')
  return value === 'checkpoints' || value === 'browser' ? value : 'files'
}

interface ActivityPanelProps {
  isPinned: boolean
  onTogglePin: () => void
  conversationId?: string | null
  focusChainTodos: TodoItem[]
  workspaceFolder: string | null
  historyWorkspaceFolder?: string | null
  historyReadOnly?: boolean
  /** Increment this whenever a new checkpoint is created to trigger auto-refresh */
  checkpointVersion?: number
  /** When set, marks this hash as HEAD in the timeline (e.g. after a rewind restore) */
  restoredHash?: string
  /** Called after a goto/hard-reset action — rolls back chat conversation to this checkpoint */
  onGoToCheckpoint?: (hash: string) => void
  titleModel?: PinnedModel
  fastModelName?: string
  isAgentBusy?: boolean
}

function ActivityPanel({
  isPinned,
  onTogglePin,
  conversationId = null,
  workspaceFolder,
  historyWorkspaceFolder = workspaceFolder,
  historyReadOnly = false,
  checkpointVersion = 0,
  restoredHash,
  onGoToCheckpoint,
  titleModel,
  fastModelName,
  isAgentBusy = false
}: ActivityPanelProps): React.JSX.Element {
  const systemTrashName = window.api.app.platform === 'windows' ? 'Recycle Bin' : 'Trash'
  const [activeTab, setActiveTab] = useState<ActivityTab>(storedActivityTab)
  const [browserActivity, setBrowserActivity] =
    useState<BrowserActivityState>(EMPTY_BROWSER_ACTIVITY)
  const autoOpenedBrowserRunRef = useRef<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(() =>
    storedActivityPanelWidth(window.localStorage.getItem('activityPanelWidth'), window.innerWidth)
  )
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, width: panelWidth })
  const [checkpoints, setCheckpoints] = useState<CheckpointHistoryItem[]>([])
  const [checkpointsLoading, setCheckpointsLoading] = useState(false)
  const [historyActionError, setHistoryActionError] = useState<{
    message: string
    conflicts?: HistoryConflict[]
  } | null>(null)
  const [restoringHash, setRestoringHash] = useState<string | null>(null)
  // null = none, 'goto' | 'reset' = type of confirm
  const [pendingAction, setPendingAction] = useState<{
    hash: string
    type: 'goto' | 'reset'
    message: string
  } | null>(null)
  // Track the "HEAD" — the most-recently-restored hash (null = tip/latest)
  const [headHash, setHeadHash] = useState<string | null>(null)
  const headItemRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.localStorage.setItem('activityPanelTab', activeTab)
  }, [activeTab])

  useEffect(() => {
    window.localStorage.setItem('activityPanelWidth', String(panelWidth))
  }, [panelWidth])

  useEffect(() => {
    const clampToViewport = (): void => {
      setPanelWidth((current) => clampActivityPanelWidth(current, window.innerWidth))
    }
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (event: PointerEvent): void => {
      const delta = resizeStartRef.current.x - event.clientX
      setPanelWidth(
        clampActivityPanelWidth(resizeStartRef.current.width + delta, window.innerWidth)
      )
    }
    const stop = (): void => setIsResizing(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
    }
  }, [isResizing])

  const handleBrowserActivityChange = useCallback(
    (state: BrowserActivityState): void => {
      setBrowserActivity(state)
      const latest = state.timeline[state.timeline.length - 1]
      const isLive = latest?.status === 'running' || latest?.status === 'pending'
      if (!state.runId || !isLive || autoOpenedBrowserRunRef.current === state.runId) return
      autoOpenedBrowserRunRef.current = state.runId
      setActiveTab('browser')
      if (!isPinned) onTogglePin()
    },
    [isPinned, onTogglePin]
  )

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isPinned || event.button !== 0) return
    resizeStartRef.current = { x: event.clientX, width: panelWidth }
    setIsResizing(true)
    event.preventDefault()
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!isPinned) return
    const step = event.shiftKey ? 50 : 20
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = panelWidth + step
    else if (event.key === 'ArrowRight') next = panelWidth - step
    else if (event.key === 'Home') next = ACTIVITY_PANEL_MIN_WIDTH
    else if (event.key === 'End') next = activityPanelMaximumWidth(window.innerWidth)
    if (next === undefined) return
    event.preventDefault()
    setPanelWidth(clampActivityPanelWidth(next, window.innerWidth))
  }

  const toggleWidePanel = (): void => {
    const wide = clampActivityPanelWidth(ACTIVITY_PANEL_WIDE_WIDTH, window.innerWidth)
    setPanelWidth((current) =>
      current >= wide - 20
        ? clampActivityPanelWidth(ACTIVITY_PANEL_DEFAULT_WIDTH, window.innerWidth)
        : wide
    )
  }

  const openCollapsedTab = (tab: ActivityTab): void => {
    setActiveTab(tab)
    onTogglePin()
  }

  const latestBrowserItem = browserActivity.timeline[browserActivity.timeline.length - 1]
  const browserIsLive =
    latestBrowserItem?.status === 'running' || latestBrowserItem?.status === 'pending'

  useCheckpointTitleBackfill({
    enabled: activeTab === 'checkpoints' && !checkpointsLoading && !historyReadOnly,
    workspaceFolder: historyWorkspaceFolder,
    checkpoints,
    model: titleModel,
    fastModelName,
    isAgentBusy,
    onTitleApplied: (hash, title) => {
      setCheckpoints((current) =>
        current.map((checkpoint) =>
          checkpoint.hash === hash
            ? {
                ...checkpoint,
                message: title,
                titleSource: 'generated',
                titleVersion: CHECKPOINT_TITLE_VERSION
              }
            : checkpoint
        )
      )
    }
  })

  // File explorer state
  const [fileMap, setFileMap] = useState<Map<string, string[]>>(new Map())
  const [fileTreeLoading, setFileTreeLoading] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [fileRootName, setFileRootName] = useState<string>('')
  const [fileRefreshKey, setFileRefreshKey] = useState(0)
  const [pendingFileDelete, setPendingFileDelete] = useState<string | null>(null)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [fileActionError, setFileActionError] = useState<string | null>(null)

  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (!historyWorkspaceFolder) {
      setCheckpoints([])
      return
    }
    const result = await window.api.workspace.listCheckpoints(historyWorkspaceFolder)
    setCheckpoints(result.ok ? result.checkpoints : [])
    if (result.ok) setHeadHash(result.status?.appliedHash ?? result.checkpoints[0]?.hash ?? null)
    else setHistoryActionError({ message: result.error || 'History could not be loaded.' })
  }, [historyWorkspaceFolder])

  useEffect(() => {
    setPendingAction(null)
    setHeadHash(null)
    setHistoryActionError(null)
  }, [historyReadOnly, historyWorkspaceFolder])

  // Load checkpoints when switching to that tab OR when a new checkpoint is created
  useEffect(() => {
    if (activeTab !== 'checkpoints') return
    setCheckpointsLoading(true)
    loadCheckpoints()
      .catch(() => setCheckpoints([]))
      .finally(() => setCheckpointsLoading(false))
  }, [activeTab, checkpointVersion, loadCheckpoints])

  // When a new checkpoint is created, reset HEAD to tip so the latest entry shows as HEAD.
  // When an external restore happens (rewind), set HEAD to the restored hash.
  useEffect(() => {
    if (restoredHash) setHeadHash(restoredHash)
  }, [checkpointVersion, restoredHash])

  // Scroll the HEAD item into view when checkpoints load
  useEffect(() => {
    if (activeTab === 'checkpoints' && !checkpointsLoading && headItemRef.current) {
      headItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [checkpointsLoading, activeTab])

  // Load file tree when switching to files tab or on refresh
  useEffect(() => {
    if (activeTab !== 'files') return
    let cancelled = false
    setFileTreeLoading(true)
    const load = async (): Promise<void> => {
      if (!workspaceFolder || cancelled) {
        setFileMap(new Map())
        setFileRootName('')
        setFileTreeLoading(false)
        return
      }
      const rootName = workspaceFolder.replace(/\\/g, '/').split('/').pop() || workspaceFolder
      if (!cancelled) setFileRootName(rootName)
      const result = await window.api.workspace.listFiles(workspaceFolder)
      if (!result.ok || cancelled) {
        setFileTreeLoading(false)
        return
      }
      const normalize = (p: string): string => p.replace(/\\/g, '/')
      const map = new Map<string, string[]>()
      map.set('', [])
      for (const rawFile of result.files) {
        const f = normalize(rawFile)
        const isDir = f.endsWith('/')
        const fClean = isDir ? f.slice(0, -1) : f
        const lastSlash = fClean.lastIndexOf('/')
        const parent = lastSlash >= 0 ? fClean.slice(0, lastSlash + 1) : ''
        if (!map.has(parent)) map.set(parent, [])
        map.get(parent)!.push(f)
        if (isDir && !map.has(f)) map.set(f, [])
      }
      if (!cancelled) {
        setFileMap(map)
        setFileTreeLoading(false)
      }
    }
    load().catch(() => {
      if (!cancelled) setFileTreeLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [activeTab, fileRefreshKey, workspaceFolder])

  // Auto-refresh file tree when workspace files change (main process watcher)
  useEffect(() => {
    const unsubscribe = window.api.workspace.onFilesChanged(() => {
      setFileRefreshKey((k) => k + 1)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    setPendingFileDelete(null)
    setDeletingFile(null)
    setFileActionError(null)
  }, [workspaceFolder])

  const moveFileToTrash = async (filePath: string): Promise<void> => {
    if (!workspaceFolder || deletingFile || isAgentBusy) return
    setDeletingFile(filePath)
    setFileActionError(null)
    try {
      // The in-app confirmation is the explicit approval for this user-initiated action.
      // Always Ask mode may still require the global native approval dialog.
      const requestedAccess = 'auto' as const
      const authorization = await window.api.permissions.authorize(
        workspacePermissionOperation('delete', filePath, undefined, requestedAccess)
      )
      if (!authorization.approved || !authorization.token) return

      const result = await window.api.workspace.trashFile(workspaceFolder, filePath, {
        requestedAccess,
        authorizationToken: authorization.token
      })
      if (!result.ok)
        throw new Error(result.error || `Could not move the file to ${systemTrashName}`)
      setFileRefreshKey((key) => key + 1)
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingFile(null)
    }
  }

  const showPathMenu = (filePath: string, isDirectory: boolean): void => {
    if (!workspaceFolder) return
    setFileActionError(null)
    void window.api.workspace
      .showPathMenu(filePath, workspaceFolder, isDirectory)
      .catch((error) => setFileActionError(error instanceof Error ? error.message : String(error)))
  }

  const executeAction = async (): Promise<void> => {
    if (!pendingAction || historyReadOnly || isAgentBusy) return
    const { hash, type } = pendingAction
    setPendingAction(null)
    setHistoryActionError(null)
    if (!workspaceFolder) return
    setRestoringHash(hash)
    try {
      const authorization = await authorizeCheckpointMutation(
        type === 'goto' ? 'restore' : 'hard-reset',
        hash
      )
      if (!authorization) return
      if (type === 'goto') {
        const result = await window.api.workspace.restoreCheckpoint(
          workspaceFolder,
          hash,
          authorization
        )
        if (!result.ok) {
          setHistoryActionError({
            message: result.error ?? 'This history point could not be restored.',
            conflicts: result.conflicts
          })
          return
        }
        setHeadHash(hash)
        onGoToCheckpoint?.(hash)
      } else {
        const result = await window.api.workspace.hardResetCheckpoint(
          workspaceFolder,
          hash,
          authorization
        )
        if (!result.ok) {
          setHistoryActionError({
            message: result.error ?? 'The newer history could not be removed.',
            conflicts: result.conflicts
          })
          return
        }
        setHeadHash(hash)
        onGoToCheckpoint?.(hash)
      }
      await loadCheckpoints()
    } catch (error) {
      setHistoryActionError({
        message: error instanceof Error ? error.message : 'History action failed.'
      })
    } finally {
      setRestoringHash(null)
    }
  }

  const renderFileTreeLevel = (parentPath: string, depth: number): React.ReactNode => {
    const children = fileMap.get(parentPath) || []
    const sorted = [...children].sort((a, b) => {
      const aDir = a.endsWith('/')
      const bDir = b.endsWith('/')
      if (aDir && !bDir) return -1
      if (!aDir && bDir) return 1
      return a.localeCompare(b)
    })
    return sorted.map((child) => {
      const isDir = child.endsWith('/')
      const withoutTrailing = isDir ? child.slice(0, -1) : child
      const name = withoutTrailing.split('/').pop() || withoutTrailing
      const isExpanded = expandedFolders.has(child)
      return (
        <div key={child}>
          <div
            className="file-node-row"
            onContextMenu={(event) => {
              event.preventDefault()
              showPathMenu(withoutTrailing, isDir)
            }}
          >
            <button
              className={`file-node${isDir ? ' file-node-dir' : ' file-node-file'}`}
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              onClick={() => {
                if (isDir) {
                  setExpandedFolders((prev) => {
                    const next = new Set(prev)
                    next.has(child) ? next.delete(child) : next.add(child)
                    return next
                  })
                }
              }}
              onDoubleClick={() => {
                if (!isDir && workspaceFolder) {
                  void window.api.workspace.openFile(child, workspaceFolder)
                }
              }}
              title={`${child} — right-click for file actions`}
            >
              <span className="file-node-chevron">
                {isDir && (
                  <ChevronRight
                    size={10}
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  />
                )}
              </span>
              <span className="file-node-icon">
                {isDir ? <Folder size={13} /> : <File size={13} />}
              </span>
              <span className="file-node-name">{name}</span>
            </button>
            <button
              className="file-node-action"
              onClick={() => showPathMenu(withoutTrailing, isDir)}
              title={`More actions for ${name}`}
              aria-label={`More actions for ${child}`}
            >
              <MoreHorizontal size={13} />
            </button>
            {!isDir && (
              <button
                className="file-node-delete"
                onClick={() => {
                  setFileActionError(null)
                  setPendingFileDelete(child)
                }}
                disabled={deletingFile !== null || isAgentBusy}
                title={`Delete ${name}`}
                aria-label={`Delete ${child}`}
              >
                {deletingFile === child ? (
                  <Loader2 size={12} className="icon-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
              </button>
            )}
          </div>
          {isDir && isExpanded && renderFileTreeLevel(child, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside
      className={`activity-panel ${isPinned ? 'is-pinned' : 'is-collapsed'}${isResizing ? ' is-resizing' : ''}`}
      style={isPinned ? { width: panelWidth, minWidth: panelWidth } : undefined}
    >
      {isPinned && (
        <div
          className="activity-panel-resize-handle"
          role="separator"
          aria-label="Resize workspace inspector"
          aria-orientation="vertical"
          aria-valuemin={ACTIVITY_PANEL_MIN_WIDTH}
          aria-valuemax={activityPanelMaximumWidth(window.innerWidth)}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeFromKeyboard}
          title="Drag to resize · Arrow keys adjust width"
        />
      )}
      <div className="activity-header">
        <div className="activity-tabs">
          <button
            className={`activity-tab-button ${activeTab === 'files' ? 'active' : ''}`}
            onClick={() => setActiveTab('files')}
            title="Files"
          >
            <FolderTree size={15} />
            <span className="tab-label">Files</span>
          </button>
          <button
            className={`activity-tab-button ${activeTab === 'checkpoints' ? 'active' : ''}`}
            onClick={() => setActiveTab('checkpoints')}
            title="Advanced recovery"
            aria-label="Open advanced recovery"
          >
            <History size={15} />
            <span className="tab-label">Recovery</span>
          </button>
          <button
            className={`activity-tab-button ${activeTab === 'browser' ? 'active' : ''}`}
            onClick={() => setActiveTab('browser')}
            title="Browser activity"
            aria-label="Open browser activity"
          >
            <span className="activity-tab-icon-wrap">
              <MonitorUp size={15} />
              {browserIsLive && (
                <span className="browser-live-dot" aria-label="Browser is active" />
              )}
            </span>
            <span className="tab-label">Browser</span>
          </button>
        </div>
        <div className="activity-header-right">
          <button
            className="activity-panel-toggle"
            onClick={onTogglePin}
            title={isPinned ? 'Collapse panel' : 'Expand panel'}
          >
            <PanelRight size={16} />
          </button>
        </div>
      </div>

      {isPinned ? (
        <div className="activity-content">
          {activeTab === 'files' && (
            <div className="file-explorer-wrap">
              <div className="file-explorer-header">
                <span className="file-explorer-root-name">{fileRootName || 'Workspace'}</span>
                <button
                  className="file-explorer-refresh"
                  onClick={() => setFileRefreshKey((k) => k + 1)}
                  title="Refresh file tree"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {fileActionError && (
                <div className="file-explorer-error" role="alert">
                  <AlertTriangle size={12} />
                  <span>{fileActionError}</span>
                  <button
                    onClick={() => setFileActionError(null)}
                    title="Dismiss error"
                    aria-label="Dismiss file error"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
              {fileTreeLoading ? (
                <div className="activity-empty">
                  <Loader2 size={16} className="icon-spin" />
                  <p>Loading files...</p>
                </div>
              ) : fileMap.size === 0 ? (
                <div className="activity-empty">
                  <p>No project folder</p>
                  <p className="hint">Open a project or move this chat into one</p>
                </div>
              ) : (
                <div className="file-tree">{renderFileTreeLevel('', 0)}</div>
              )}
            </div>
          )}

          {activeTab === 'checkpoints' && (
            <div className="checkpoints-timeline-wrap">
              {historyReadOnly && (
                <div className="cp-readonly-banner">
                  <History size={13} />
                  <span>
                    Detached from {historyWorkspaceFolder?.replace(/\\/g, '/').split('/').pop()} —
                    history is read-only. Reattach this chat to restore files.
                  </span>
                </div>
              )}
              {historyActionError && (
                <div className="cp-error-banner" role="alert">
                  <AlertTriangle size={13} />
                  <div>
                    <span>{historyActionError.message}</span>
                    {historyActionError.conflicts?.length ? (
                      <ul>
                        {historyActionError.conflicts.slice(0, 5).map((conflict) => (
                          <li key={`${conflict.path}:${conflict.reason}`}>
                            {conflict.path} —{' '}
                            {conflict.reason === 'staged-in-git'
                              ? 'saved for a commit in another Git tool'
                              : conflict.reason === 'unsupported-file'
                                ? 'is no longer a regular file'
                                : 'was changed after this point was saved'}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setHistoryActionError(null)}
                    aria-label="Dismiss history error"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
              {checkpointsLoading ? (
                <div className="activity-empty">
                  <Loader2 size={16} className="icon-spin" />
                  <p>Loading history...</p>
                </div>
              ) : checkpoints.length === 0 ? (
                <div className="activity-empty">
                  <p>No checkpoints yet</p>
                  <p className="hint">
                    Checkpoints are created automatically when the agent changes project files.
                  </p>
                </div>
              ) : (
                <>
                  {/* Back-to-latest bar — shown when the applied state is not at tip */}
                  {headHash && checkpoints.length > 0 && headHash !== checkpoints[0].hash && (
                    <div className="cp-back-banner">
                      <span>Viewing an older state</span>
                      <button
                        className="cp-back-btn"
                        disabled={restoringHash !== null || historyReadOnly || isAgentBusy}
                        title={
                          historyReadOnly
                            ? 'Reattach this chat to restore project files'
                            : 'Restore the latest project state'
                        }
                        onClick={() =>
                          setPendingAction({
                            hash: checkpoints[0].hash,
                            type: 'goto',
                            message: checkpoints[0].message
                          })
                        }
                      >
                        {restoringHash ? (
                          <Loader2 size={11} className="icon-spin" />
                        ) : (
                          <ArrowUp size={11} />
                        )}
                        Back to latest
                      </button>
                    </div>
                  )}

                  {/* Inline confirm banner */}
                  {pendingAction && !historyReadOnly && (
                    <div className={`cp-confirm-banner cp-confirm-${pendingAction.type}`}>
                      <div className="cp-confirm-text">
                        {pendingAction.type === 'goto' ? (
                          <>
                            Undo SideKick changes after <strong>{pendingAction.message}</strong>?
                            Unrelated manual edits stay untouched. If an affected file changed
                            later, SideKick stops instead of overwriting it.
                          </>
                        ) : (
                          <>
                            <AlertTriangle size={13} /> Remove all newer SideKick history after{' '}
                            <strong>{pendingAction.message}</strong>? The removed timeline cannot be
                            recovered.
                          </>
                        )}
                      </div>
                      <div className="cp-confirm-actions">
                        <button className="cp-confirm-yes" onClick={() => void executeAction()}>
                          {restoringHash ? <Loader2 size={11} className="icon-spin" /> : 'Confirm'}
                        </button>
                        <button className="cp-confirm-no" onClick={() => setPendingAction(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="checkpoints-timeline">
                    {checkpoints.map((cp, idx) => {
                      const isHead = headHash ? cp.hash === headHash : idx === 0
                      const isTip = idx === 0
                      const isBusy = restoringHash !== null || isAgentBusy
                      return (
                        <div
                          key={cp.hash}
                          className={`cp-node ${isHead ? 'cp-node-head' : ''}`}
                          ref={isHead ? headItemRef : undefined}
                        >
                          {/* Timeline spine */}
                          <div className="cp-spine">
                            <div className={`cp-dot ${isHead ? 'cp-dot-head' : ''}`} />
                            {idx < checkpoints.length - 1 && <div className="cp-line" />}
                          </div>

                          {/* Content */}
                          <div className="cp-body">
                            <div className="cp-labels">
                              {isHead && <span className="cp-head-badge">Current</span>}
                              {isTip && !isHead && <span className="cp-tip-badge">Latest</span>}
                              <span className="cp-msg">{cp.message}</span>
                            </div>
                            <span className="cp-time">
                              {new Date(cp.timestamp).toLocaleString()}
                              {cp.changeCount !== undefined
                                ? ` · ${cp.changeCount} ${cp.changeCount === 1 ? 'file' : 'files'}`
                                : ''}
                            </span>
                            <div className="cp-actions">
                              <button
                                className="cp-btn cp-btn-goto"
                                disabled={isBusy || isHead || historyReadOnly}
                                title={
                                  historyReadOnly
                                    ? 'Reattach this chat to restore project files'
                                    : 'Restore files to this point (keep history)'
                                }
                                onClick={() =>
                                  setPendingAction({
                                    hash: cp.hash,
                                    type: 'goto',
                                    message: cp.message
                                  })
                                }
                              >
                                <RotateCcw size={11} /> Restore
                              </button>
                              <button
                                className="cp-btn cp-btn-reset cp-btn-reset-hidden"
                                disabled={isBusy || isHead || historyReadOnly}
                                title={
                                  historyReadOnly
                                    ? 'Reattach this chat to change project history'
                                    : 'Remove all newer SideKick history and restore this point'
                                }
                                onClick={() =>
                                  setPendingAction({
                                    hash: cp.hash,
                                    type: 'reset',
                                    message: cp.message
                                  })
                                }
                              >
                                <X size={11} /> Remove newer
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="activity-browser-wrap" hidden={activeTab !== 'browser'}>
            <BrowserActivityPanel
              conversationId={conversationId}
              onActivityChange={handleBrowserActivityChange}
              isWide={panelWidth >= ACTIVITY_PANEL_WIDE_WIDTH - 20}
              onToggleWidth={toggleWidePanel}
            />
          </div>
        </div>
      ) : (
        <div className="activity-collapsed-tabs">
          <button
            className="activity-tab-vertical"
            onClick={() => openCollapsedTab('files')}
            title="Open Files"
            aria-label="Open Files"
          >
            <FolderTree size={17} />
          </button>
          <button
            className="activity-tab-vertical"
            onClick={() => openCollapsedTab('checkpoints')}
            title="Open Recovery"
            aria-label="Open Recovery"
          >
            <History size={17} />
          </button>
          <button
            className="activity-tab-vertical"
            onClick={() => openCollapsedTab('browser')}
            title="Open Browser activity"
            aria-label="Open Browser activity"
          >
            <MonitorUp size={17} />
            {browserIsLive && <span className="collapsed-tab-badge">Live</span>}
          </button>
        </div>
      )}
      {!isPinned && (
        <div hidden aria-hidden="true">
          <BrowserActivityPanel
            conversationId={conversationId}
            onActivityChange={handleBrowserActivityChange}
          />
        </div>
      )}
      <ConfirmDialog
        isOpen={pendingFileDelete !== null}
        title="Delete file?"
        message={`Move “${pendingFileDelete || ''}” to the ${systemTrashName}? You can restore it from there.`}
        confirmText={`Move to ${systemTrashName}`}
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          const filePath = pendingFileDelete
          setPendingFileDelete(null)
          if (filePath) void moveFileToTrash(filePath)
        }}
        onCancel={() => setPendingFileDelete(null)}
      />
    </aside>
  )
}

export default ActivityPanel
