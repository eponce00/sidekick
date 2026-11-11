import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { FolderTree, Globe, SquareTerminal, Workflow } from 'lucide-react'
import { TerminalPanel } from './TerminalPanel'
import { subscribeTerminalView, useTerminalSessions } from '../utils/terminalSessionStore'
import { terminalSessionIsLive } from '../../../shared/terminalSessions'
import type { TodoItem } from '../../../shared/types'
import BrowserActivityPanel from './BrowserActivityPanel'
import { EMPTY_BROWSER_ACTIVITY, type BrowserActivityState } from '../utils/browserActivity'
import {
  ACTIVITY_PANEL_MIN_WIDTH,
  ACTIVITY_PANEL_NARROW_WIDTH,
  PANEL_GLIDE_MS,
  SIDEBAR_RAIL_WIDTH,
  type ActivityPanelSize,
  ACTIVITY_PANEL_FOLD_WIDTH,
  activityPanelMaximumWidth,
  clampActivityPanelWidth,
  snapActivityPanelWidth
} from '../utils/activityPanelLayout'
import { FilesPanel } from './FilesPanel'
import {
  subscribeWorkspaceFileView,
  type WorkspaceFileViewRequest
} from '../utils/workspaceFileViewer'
import { ChatsTab } from './ChatsPanel'
import { useSessionFamily } from '../hooks/useSessionFamily'
import { PanelSections, type PanelAppInfo } from './sidePanel/PanelSections'
import { isPanelWindowApp, type PanelWindowEntry } from '../../../shared/panelWindows'
import {
  findApp,
  openApp,
  removeApp,
  shownApps,
  storePanelLayout,
  storedPanelLayout,
  type PanelApp,
  type PanelLayout,
  type PanelTabKind
} from './sidePanel/panelLayout'
import './ActivityPanel.css'

type ActivityTab = PanelApp

/** The tab an older SideKick left showing, for the first layout. */
function storedActivityTab(): ActivityTab {
  const value = window.localStorage.getItem('activityPanelTab')
  return value === 'browser' || value === 'terminal' || value === 'chats' ? value : 'files'
}

interface ActivityPanelProps {
  isPinned: boolean
  onTogglePin: () => void
  conversationId?: string | null
  focusChainTodos: TodoItem[]
  workspaceFolder: string | null
  /** The folder is the chat's own, as it has no project. */
  chatFolder?: boolean
  isAgentBusy?: boolean
  /** Shows a tab when `at` changes, as when the command palette asks for the browser. */
  tabRequest?: { tab: ActivityTab; at: number } | null
  /** The app on screen: the browser while it shows anywhere, else the last section used's. */
  onActiveTabChange?: (tab: PanelTabKind) => void
  /** The widest the panel may render now; its preferred width is kept for later. */
  maxWidth?: number
  /** The width the user left it at; the layout keeps it and makes room for it. */
  width?: number
  /** Sets the width as the user drags the edge, and where it settles. */
  onWidthChange?: (width: number) => void
  /** Beside the chat, or across the whole window. */
  size?: ActivityPanelSize
  /**
   * Enables resizing beside the chat and an explicit full-window button. Left out where the
   * panel floats over the chat instead.
   */
  onSizeChange?: (size: ActivityPanelSize) => void
  /** The widest the panel fits beside the chat; dragged well past it, it takes the window. */
  sideBySideMaxWidth?: number
  /** Widths the edge snaps to when let go near them. */
  snapWidths?: readonly number[]
  /** The edge is about to glide to a new width, so the layout can hold the chat still. */
  onSettle?: () => void
  /** Opens another chat, from the Chats tab. */
  onOpenConversation?: (conversationId: string) => void
  /** Opens a project folder for the chat, from the Files tab while it has none. */
  onOpenProject?: () => void
  /** Opens Settings where the browser's own settings are. */
  onOpenBrowserSettings?: () => void
  /** Whether what the panel shows needs its width, or only the narrow column. */
  onNeedsRoomChange?: (needsRoom: boolean) => void
}

function ActivityPanel({
  isPinned,
  onTogglePin,
  conversationId = null,
  workspaceFolder,
  chatFolder = false,
  isAgentBusy = false,
  tabRequest = null,
  onActiveTabChange,
  maxWidth,
  width = ACTIVITY_PANEL_NARROW_WIDTH,
  onWidthChange,
  size = 'wide',
  onSizeChange,
  sideBySideMaxWidth,
  snapWidths = [ACTIVITY_PANEL_NARROW_WIDTH],
  onSettle,
  onOpenConversation,
  onOpenProject,
  onOpenBrowserSettings,
  onNeedsRoomChange
}: ActivityPanelProps): React.JSX.Element {
  const [layout, setLayout] = useState<PanelLayout>(() => storedPanelLayout(storedActivityTab()))
  useEffect(() => storePanelLayout(layout), [layout])
  // This chat's apps dragged out into windows of their own.
  const [panelWindows, setPanelWindows] = useState<PanelWindowEntry[]>([])
  useEffect(() => {
    const api = window.api.panelWindows
    if (!api) return
    void api.list().then(setPanelWindows)
    return api.onChanged(setPanelWindows)
  }, [])
  const detached = useMemo(
    () =>
      new Set<ActivityTab>(
        panelWindows
          .filter((entry) => entry.conversationId === conversationId)
          .map((entry) => entry.app)
      ),
    [panelWindows, conversationId]
  )
  const detachedRef = useRef(detached)
  useEffect(() => {
    detachedRef.current = detached
  }, [detached])
  /**
   * Shows an app: its window when it has one of its own, else its tab, else a new tab in the
   * section last used. Says whether it shows in the panel.
   */
  const showApp = useCallback(
    (app: ActivityTab): boolean => {
      if (conversationId && isPanelWindowApp(app) && detachedRef.current.has(app)) {
        void window.api.panelWindows.focus({ app, conversationId })
        return false
      }
      setLayout((current) => openApp(current, app))
      return true
    },
    [conversationId]
  )
  // A window put back: its app shows in the panel again, its tab lighting up as it lands.
  const [arriving, setArriving] = useState<ActivityTab | null>(null)
  const isPinnedRef = useRef(isPinned)
  useEffect(() => {
    isPinnedRef.current = isPinned
  }, [isPinned])
  useEffect(
    () =>
      window.api.panelWindows?.onDocked((entry) => {
        if (entry.conversationId !== conversationId) return
        setLayout((current) => openApp(current, entry.app))
        setArriving(entry.app)
        window.setTimeout(
          () => setArriving((current) => (current === entry.app ? null : current)),
          800
        )
        if (!isPinnedRef.current) onTogglePin()
      }),
    [conversationId, onTogglePin]
  )
  const tearOut = (app: ActivityTab, point: { x: number; y: number }): void => {
    if (!conversationId || !isPanelWindowApp(app)) return
    void window.api.panelWindows
      .open({ app, conversationId, ...point })
      .then((opened) => opened && setLayout((current) => removeApp(current, app)))
  }
  const sessionFamily = useSessionFamily(conversationId)
  const familyRole = sessionFamily.role
  // The Chats app exists only for a chat with a family; elsewhere its tab closes.
  if (!familyRole && findApp(layout, 'chats')) setLayout((current) => removeApp(current, 'chats'))
  const shown = shownApps(layout)
  const filesShown = isPinned && shown.includes('files')
  const [handledTabRequestAt, setHandledTabRequestAt] = useState(tabRequest?.at)
  if (tabRequest && tabRequest.at !== handledTabRequestAt) {
    setHandledTabRequestAt(tabRequest.at)
    setLayout((current) => openApp(current, tabRequest.tab))
  }
  const [browserActivity, setBrowserActivity] =
    useState<BrowserActivityState>(EMPTY_BROWSER_ACTIVITY)
  // An empty browser tab, or a new tab's launcher, needs no room: the panel keeps the narrow
  // column until a page shows, instead of taking the chat's width for nothing.
  const [browserPageShown, setBrowserPageShown] = useState(false)
  const needsRoom =
    !isPinned || shown.some((app) => app !== 'launcher' && (app !== 'browser' || browserPageShown))
  const needsRoomRef = useRef(needsRoom)
  const autoOpenedWaitRef = useRef<string | null>(null)
  const autoOpenedBrowserRunRef = useRef<string | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [isGliding, setIsGliding] = useState(false)
  const widthLimit = maxWidth ?? Number.POSITIVE_INFINITY
  const renderedWidth =
    size === 'full' && Number.isFinite(widthLimit) ? widthLimit : Math.min(width, widthLimit)
  const resizable = Boolean(onSizeChange)
  const glideTimerRef = useRef<number | undefined>(undefined)
  const glide = (): void => {
    setIsGliding(true)
    window.clearTimeout(glideTimerRef.current)
    glideTimerRef.current = window.setTimeout(() => setIsGliding(false), PANEL_GLIDE_MS + 40)
  }
  useEffect(() => () => window.clearTimeout(glideTimerRef.current), [])
  // When a page opens in an empty browser, or the panel goes back to showing nothing that needs
  // room, it glides between the narrow column and its width.
  useEffect(() => {
    if (needsRoomRef.current === needsRoom) return
    needsRoomRef.current = needsRoom
    glide()
    onNeedsRoomChange?.(needsRoom)
  })
  const resizeStartRef = useRef({
    x: 0,
    width,
    preferredWidth: width,
    isPinned,
    size,
    pointerId: 0,
    handle: null as HTMLDivElement | null
  })
  // The drag reads the latest layout and callbacks without restarting.
  const dragContextRef = useRef({
    isPinned,
    size,
    sideBySideMaxWidth,
    snapWidths,
    width,
    onTogglePin,
    onSizeChange,
    onWidthChange,
    onSettle
  })
  useEffect(() => {
    dragContextRef.current = {
      isPinned,
      size,
      sideBySideMaxWidth,
      snapWidths,
      width,
      onTogglePin,
      onSizeChange,
      onWidthChange,
      onSettle
    }
  })
  // The app the user is looking at; the browser counts as long as it is on screen.
  const focusedApp =
    shown[layout.sections.findIndex((section) => section.id === layout.focusedSectionId)] ?? 'files'
  const reportedTab = shown.includes('browser') ? 'browser' : focusedApp
  useEffect(() => {
    onActiveTabChange?.(reportedTab)
  }, [reportedTab, onActiveTabChange])

  useEffect(() => {
    if (!isResizing) return
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const start = resizeStartRef.current
    let pointerWidth = start.width
    let target = start.width
    let moved = false
    let finished = false
    let frame = 0
    // Keep the page following the edge, without rendering more than once per screen frame.
    const paint = (): void => {
      frame = 0
      if (pointerWidth < ACTIVITY_PANEL_FOLD_WIDTH) return
      const context = dragContextRef.current
      if (context.size === 'full') context.onSizeChange?.('wide')
      context.onWidthChange?.(target)
      if (!context.isPinned) context.onTogglePin()
    }
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== start.pointerId || finished) return
      pointerWidth = start.width + start.x - event.clientX
      moved ||= pointerWidth !== start.width
      const context = dragContextRef.current
      target = Math.min(
        clampActivityPanelWidth(pointerWidth, window.innerWidth),
        context.sideBySideMaxWidth ?? activityPanelMaximumWidth(window.innerWidth)
      )
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    const finish = (apply: boolean): void => {
      if (finished) return
      finished = true
      window.cancelAnimationFrame(frame)
      const context = dragContextRef.current
      if (!apply && moved) {
        context.onWidthChange?.(start.preferredWidth)
        if (context.size !== start.size) context.onSizeChange?.(start.size)
        if (context.isPinned !== start.isPinned) context.onTogglePin()
      } else if (moved && pointerWidth < ACTIVITY_PANEL_FOLD_WIDTH) {
        context.onWidthChange?.(start.preferredWidth)
        if (context.isPinned) context.onTogglePin()
      } else if (moved) {
        // Snaps help only at release, within a few pixels; the drag itself stays continuous.
        target = snapActivityPanelWidth(target, context.snapWidths)
        paint()
      }
      setIsResizing(false)
    }
    const stop = (event: PointerEvent): void => {
      if (event.pointerId === start.pointerId) finish(true)
    }
    const cancel = (event?: Event): void => {
      if (event && 'pointerId' in event && event.pointerId !== start.pointerId) return
      finish(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    start.handle?.addEventListener('lostpointercapture', cancel)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      start.handle?.removeEventListener('lostpointercapture', cancel)
      if (start.handle?.hasPointerCapture(start.pointerId))
        start.handle.releasePointerCapture(start.pointerId)
      window.removeEventListener('keydown', escape, true)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
    }
  }, [isResizing])

  const handleBrowserActivityChange = useCallback(
    (state: BrowserActivityState): void => {
      setBrowserActivity(state)
      const latest = state.timeline[state.timeline.length - 1]
      const isLive = latest?.status === 'running' || latest?.status === 'pending'
      if (!state.runId || !isLive) return
      // The agent waits for the user to clear a check on the page: show it to them.
      const waitsForUser =
        latest.name === 'browser_request_human' && autoOpenedWaitRef.current !== latest.callId
      if (autoOpenedBrowserRunRef.current === state.runId && !waitsForUser) return
      autoOpenedBrowserRunRef.current = state.runId
      if (waitsForUser) autoOpenedWaitRef.current = latest.callId
      // A browser in its own window is in view already; it comes forward only for the user's check.
      if (detachedRef.current.has('browser') && !waitsForUser) return
      if (showApp('browser') && !isPinned) onTogglePin()
    },
    // The stable setter is listed because the React Compiler cannot prove it stable here.
    [isPinned, onTogglePin, showApp, setBrowserActivity]
  )

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!resizable || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStartRef.current = {
      x: event.clientX,
      width: isPinned ? renderedWidth : SIDEBAR_RAIL_WIDTH,
      preferredWidth: width,
      isPinned,
      size,
      pointerId: event.pointerId,
      handle: event.currentTarget
    }
    setIsGliding(false)
    setIsResizing(true)
    event.preventDefault()
  }

  // Double-clicking the edge moves between the narrow column and the widest snap width.
  const toggleSnapWidth = (): void => {
    if (!resizable || !isPinned) return
    const widest = snapWidths[snapWidths.length - 1] ?? ACTIVITY_PANEL_NARROW_WIDTH
    glide()
    onSettle?.()
    if (size === 'full') onSizeChange?.('wide')
    onWidthChange?.(
      size === 'wide' && Math.abs(renderedWidth - ACTIVITY_PANEL_NARROW_WIDTH) < 8
        ? widest
        : ACTIVITY_PANEL_NARROW_WIDTH
    )
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!resizable || !isPinned) return
    const step = event.shiftKey ? 50 : 20
    const sideBySideMax = sideBySideMaxWidth ?? activityPanelMaximumWidth(window.innerWidth)
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = renderedWidth + step
    else if (event.key === 'ArrowRight') next = renderedWidth - step
    else if (event.key === 'Home') next = ACTIVITY_PANEL_MIN_WIDTH
    else if (event.key === 'End') next = sideBySideMax
    if (next === undefined) return
    event.preventDefault()
    if (size === 'full') onSizeChange?.('wide')
    onWidthChange?.(Math.min(clampActivityPanelWidth(next, window.innerWidth), sideBySideMax))
  }

  const openCollapsedTab = (tab: ActivityTab): void => {
    if (showApp(tab)) onTogglePin()
  }

  const latestBrowserItem = browserActivity.timeline[browserActivity.timeline.length - 1]
  const browserIsLive =
    latestBrowserItem?.status === 'running' || latestBrowserItem?.status === 'pending'

  const [fileRequest, setFileRequest] = useState<{
    request: WorkspaceFileViewRequest
    at: number
  } | null>(null)
  const [terminalRequest, setTerminalRequest] = useState<{ id: string; at: number } | null>(null)
  const terminalSessions = useTerminalSessions(conversationId)
  const terminalIsLive = terminalSessions.some((session) => terminalSessionIsLive(session.state))
  const terminalWaitingCount = terminalSessions.filter(
    (session) => session.state === 'waiting_for_input'
  ).length
  const terminalIsWaiting = terminalWaitingCount > 0

  // "Open in Terminal" on a command in the chat shows it here.
  useEffect(
    () =>
      subscribeTerminalView((id) => {
        setTerminalRequest({ id, at: Date.now() })
        if (showApp('terminal') && !isPinned) onTogglePin()
      }),
    [isPinned, onTogglePin, showApp]
  )

  // A file reference clicked anywhere in the app opens here, over the tree,
  // and makes sure the panel is actually visible to show it.
  useEffect(
    () =>
      subscribeWorkspaceFileView((request) => {
        setFileRequest({ request, at: Date.now() })
        if (showApp('files') && !isPinned) onTogglePin()
      }),
    [isPinned, onTogglePin, showApp]
  )
  // Files takes the request while it is on screen; it is let go when Files hides, so showing
  // Files again later starts at the tree, not at a file the user already closed.
  const [filesWereShown, setFilesWereShown] = useState(filesShown)
  if (filesShown !== filesWereShown) {
    setFilesWereShown(filesShown)
    if (!filesShown) setFileRequest(null)
  }

  const familyWaitingCount = sessionFamily.family
    ? [sessionFamily.family.manager, ...sessionFamily.family.workers].filter(
        (member) =>
          (sessionFamily.statuses.get(member.conversationId)?.state ?? member.state) === 'waiting'
      ).length
    : 0
  const familyWaiting = familyWaitingCount > 0
  const panelApps: Partial<Record<PanelApp, PanelAppInfo>> = {
    ...(familyRole
      ? {
          chats: {
            label: familyRole === 'manager' ? 'Chats' : 'Details',
            description:
              familyRole === 'manager' ? 'The chats started here' : 'This chat and its family',
            icon: <Workflow size={15} />,
            ...(familyWaiting
              ? { badge: 'waiting' as const, waitingCount: familyWaitingCount }
              : {})
          }
        }
      : {}),
    files: {
      label: 'Files',
      description: "The project's files",
      icon: <FolderTree size={15} />
    },
    browser: {
      label: 'Browser',
      description: 'The browser you share with the agent',
      icon: <Globe size={15} />,
      ...(browserIsLive ? { badge: 'live' as const } : {})
    },
    terminal: {
      label: 'Terminal',
      description: "Your terminals and the agent's commands",
      icon: <SquareTerminal size={15} />,
      ...(terminalIsLive
        ? terminalIsWaiting
          ? { badge: 'waiting' as const, waitingCount: terminalWaitingCount }
          : { badge: 'live' as const }
        : {})
    }
  }
  const browserPlaced = isPinned && Boolean(findApp(layout, 'browser')) && !detached.has('browser')
  const renderApp = (kind: PanelApp, active: boolean): React.ReactNode => {
    // In a window of its own, an app is not shown here too: its tab says where it is.
    if (detached.has(kind))
      return (
        active && (
          <div className="activity-empty">
            <p>{panelApps[kind]?.label ?? 'This app'} is in a window of its own</p>
            <button
              type="button"
              className="settings-secondary-action is-small activity-detached-focus"
              onClick={() => showApp(kind)}
            >
              Go to it
            </button>
          </div>
        )
      )
    // The browser stays mounted while hidden, so it keeps following the agent's activity.
    if (kind === 'browser')
      return (
        <div className="activity-browser-wrap" hidden={!active}>
          <BrowserActivityPanel
            conversationId={conversationId}
            onActivityChange={handleBrowserActivityChange}
            onOpenSettings={onOpenBrowserSettings}
            onPageShownChange={setBrowserPageShown}
          />
        </div>
      )
    if (!active) return null
    if (kind === 'files')
      return (
        <FilesPanel
          workspaceFolder={workspaceFolder}
          chatFolder={chatFolder}
          isAgentBusy={isAgentBusy}
          fileRequest={fileRequest}
          onOpenProject={onOpenProject}
        />
      )
    if (kind === 'terminal')
      return <TerminalPanel conversationId={conversationId} requestedSessionId={terminalRequest} />
    return conversationId ? (
      <ChatsTab
        conversationId={conversationId}
        view={sessionFamily}
        onOpenChat={(id) => onOpenConversation?.(id)}
      />
    ) : null
  }

  return (
    <>
      {/* Below the overlay breakpoint the pinned panel floats over the chat.
          The scrim keeps the covered composer from looking broken and gives
          the drawer a one-click dismissal; CSS hides it at full width. */}
      {isPinned && (
        <div className="activity-panel-scrim" aria-hidden="true" onClick={onTogglePin} />
      )}
      <aside
        className={`activity-panel ${isPinned ? 'is-pinned' : 'is-collapsed'}${isResizing ? ' is-resizing' : ''}${isGliding ? ' is-gliding' : ''}`}
        data-size={isPinned ? size : undefined}
        style={
          isPinned
            ? ({
                width: renderedWidth,
                minWidth: renderedWidth,
                '--panel-content-width': `${renderedWidth}px`
              } as React.CSSProperties)
            : undefined
        }
      >
        {resizable && (
          <div
            className="activity-panel-resize-handle"
            role="separator"
            aria-label="Resize workspace inspector"
            aria-orientation="vertical"
            aria-valuemin={ACTIVITY_PANEL_MIN_WIDTH}
            aria-valuemax={sideBySideMaxWidth ?? activityPanelMaximumWidth(window.innerWidth)}
            aria-valuenow={isPinned ? renderedWidth : 0}
            tabIndex={0}
            onPointerDown={beginResize}
            onDoubleClick={toggleSnapWidth}
            onKeyDown={resizeFromKeyboard}
            title={
              isPinned
                ? 'Drag to resize · Double-click for an even split or narrow width'
                : 'Drag to open'
            }
          />
        )}
        {isPinned ? (
          <div className="activity-content">
            <PanelSections
              layout={layout}
              apps={panelApps}
              onChange={setLayout}
              renderApp={renderApp}
              onFold={onTogglePin}
              expanded={size === 'full'}
              onToggleExpand={
                resizable
                  ? () => {
                      glide()
                      onSettle?.()
                      onSizeChange?.(size === 'full' ? 'wide' : 'full')
                    }
                  : undefined
              }
              onTearOut={tearOut}
              arriving={arriving}
              elsewhere={detached}
              onShowElsewhere={showApp}
            />
          </div>
        ) : (
          // An app waiting on the user carries the shared count badge, as its tab does.
          <div className="activity-collapsed-tabs">
            {familyRole && (
              <button
                className="activity-tab-vertical"
                onClick={() => openCollapsedTab('chats')}
                title={familyRole === 'manager' ? 'Open Chats' : 'Open Details'}
                aria-label={`${familyRole === 'manager' ? 'Open Chats' : 'Open Details'}${
                  familyWaiting ? `, ${familyWaitingCount} waiting for you` : ''
                }`}
              >
                <Workflow size={16} />
                {familyWaiting && (
                  <span className="count-badge is-attention" aria-hidden="true">
                    {familyWaitingCount}
                  </span>
                )}
              </button>
            )}
            <button
              className="activity-tab-vertical"
              onClick={() => openCollapsedTab('files')}
              title="Open Files"
              aria-label="Open Files"
            >
              <FolderTree size={16} />
            </button>
            <button
              className="activity-tab-vertical"
              onClick={() => openCollapsedTab('browser')}
              title={browserIsLive ? 'Open Browser activity · Working' : 'Open Browser activity'}
              aria-label="Open Browser activity"
            >
              <Globe size={16} />
              {browserIsLive && <span className="browser-live-dot" aria-hidden="true" />}
            </button>
            <button
              className="activity-tab-vertical"
              onClick={() => openCollapsedTab('terminal')}
              title={
                terminalIsLive
                  ? `Open Terminal · ${terminalIsWaiting ? 'Waiting for input' : 'Running'}`
                  : 'Open Terminal'
              }
              aria-label={`Open Terminal${
                terminalIsWaiting ? `, ${terminalWaitingCount} waiting for you` : ''
              }`}
            >
              <SquareTerminal size={16} />
              {terminalIsWaiting ? (
                <span className="count-badge is-attention" aria-hidden="true">
                  {terminalWaitingCount}
                </span>
              ) : (
                terminalIsLive && <span className="browser-live-dot" aria-hidden="true" />
              )}
            </button>
          </div>
        )}
        {!browserPlaced && (
          <div hidden aria-hidden="true">
            <BrowserActivityPanel
              conversationId={conversationId}
              onActivityChange={handleBrowserActivityChange}
              onOpenSettings={onOpenBrowserSettings}
              onPageShownChange={setBrowserPageShown}
            />
          </div>
        )}
      </aside>
    </>
  )
}

export default ActivityPanel
