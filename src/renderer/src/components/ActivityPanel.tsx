import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import {
  Columns2,
  Maximize2,
  PanelRight,
  PanelRightClose,
  FolderTree,
  MonitorUp,
  SquareTerminal,
  Workflow
} from 'lucide-react'
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
  activityPanelDragZone,
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

/** Where a dragged edge would leave the panel if let go now. */
type PanelLanding = 'fold' | 'full' | 'narrow' | 'split' | 'free'

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
   * Makes the edge draggable across every size: beside the chat, the whole window, or folded to
   * the rail. Left out where the panel floats over the chat instead.
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
  /** Opens Settings where the browser's own settings are. */
  onOpenBrowserSettings?: () => void
}

function ActivityPanel({
  isPinned,
  onTogglePin,
  conversationId = null,
  workspaceFolder,
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
  onOpenBrowserSettings
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
  const autoOpenedWaitRef = useRef<string | null>(null)
  const autoOpenedBrowserRunRef = useRef<string | null>(null)
  // While the edge is dragged nothing else moves: a phantom shows where the panel will land and
  // what letting go will do. Let go, the panel glides there once (is-gliding), so the chat and the
  // sidebar re-lay out a single time instead of on every pointer move.
  const [landing, setLanding] = useState<PanelLanding | null>(null)
  const [isGliding, setIsGliding] = useState(false)
  const isResizing = landing !== null
  const panelRef = useRef<HTMLElement>(null)
  const phantomRef = useRef<HTMLDivElement>(null)
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
  const resizeStartRef = useRef({ x: 0, width, landing: 'free' as PanelLanding })
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
    const phantom = phantomRef.current
    const panelBox = panelRef.current?.getBoundingClientRect()
    const right = panelBox?.right || window.innerWidth
    if (phantom && panelBox) {
      phantom.style.top = `${panelBox.top}px`
      phantom.style.height = `${panelBox.height}px`
      phantom.style.right = `${window.innerWidth - right}px`
    }
    let current = start.landing
    let target = start.width
    let frame = 0
    // Pointer events can outpace the screen; the phantom is written once a frame, outside React.
    const paint = (): void => {
      frame = 0
      if (!phantom) return
      phantom.style.width = `${target}px`
      phantom.dataset.shown = ''
    }
    if (phantom) phantom.style.width = `${target}px`
    const move = (event: PointerEvent): void => {
      if (event.clientX === start.x && current === start.landing) return
      const context = dragContextRef.current
      const pointerWidth = start.width + (start.x - event.clientX)
      const sideBySideMax =
        context.sideBySideMaxWidth ?? activityPanelMaximumWidth(window.innerWidth)
      const zone = activityPanelDragZone(pointerWidth, sideBySideMax)
      let next: PanelLanding
      if (zone === 'fold') {
        next = 'fold'
        target = SIDEBAR_RAIL_WIDTH
      } else if (zone === 'full') {
        next = 'full'
        target = right - SIDEBAR_RAIL_WIDTH
      } else {
        const fitted = Math.min(
          clampActivityPanelWidth(pointerWidth, window.innerWidth),
          sideBySideMax
        )
        // The phantom settles on a snap width as the panel will when let go there.
        target = snapActivityPanelWidth(fitted, context.snapWidths)
        next = !context.snapWidths.includes(target)
          ? 'free'
          : target === ACTIVITY_PANEL_NARROW_WIDTH
            ? 'narrow'
            : 'split'
      }
      if (next !== current) {
        current = next
        setLanding(next)
      }
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    const finish = (apply: boolean): void => {
      const context = dragContextRef.current
      const fromSide = context.isPinned && context.size !== 'full'
      const settle = (): void => {
        glide()
        context.onSettle?.()
      }
      if (!apply || (current === start.landing && target === start.width)) {
        // Let go where it started: nothing changes.
      } else if (current === 'fold') {
        // Folded to the rail, it opens again at the width it had.
        if (context.isPinned) {
          settle()
          context.onTogglePin()
        }
      } else if (current === 'full') {
        if (context.size !== 'full' || !context.isPinned) {
          settle()
          context.onSizeChange?.('full')
          if (!context.isPinned) context.onTogglePin()
        }
      } else if (!fromSide || target !== start.width) {
        settle()
        if (context.size === 'full') context.onSizeChange?.('wide')
        context.onWidthChange?.(target)
        if (!context.isPinned) context.onTogglePin()
      }
      setLanding(null)
    }
    const stop = (): void => finish(true)
    const cancel = (): void => finish(false)
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', cancel, { once: true })
    window.addEventListener('keydown', escape, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
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
    const startLanding: PanelLanding = !isPinned
      ? 'fold'
      : size === 'full'
        ? 'full'
        : renderedWidth === ACTIVITY_PANEL_NARROW_WIDTH
          ? 'narrow'
          : snapWidths.includes(renderedWidth)
            ? 'split'
            : 'free'
    resizeStartRef.current = {
      x: event.clientX,
      width: isPinned ? renderedWidth : SIDEBAR_RAIL_WIDTH,
      landing: startLanding
    }
    setLanding(startLanding)
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
  const terminalIsWaiting = terminalSessions.some(
    (session) => session.state === 'waiting_for_input'
  )

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

  const familyWaiting = Boolean(
    sessionFamily.family &&
    [sessionFamily.family.manager, ...sessionFamily.family.workers].some(
      (member) =>
        (sessionFamily.statuses.get(member.conversationId)?.state ?? member.state) === 'waiting'
    )
  )
  const panelApps: Partial<Record<PanelApp, PanelAppInfo>> = {
    ...(familyRole
      ? {
          chats: {
            label: familyRole === 'manager' ? 'Chats' : 'Details',
            description:
              familyRole === 'manager' ? 'The chats started here' : 'This chat and its family',
            icon: <Workflow size={15} />,
            ...(familyWaiting ? { badge: 'waiting' as const } : {})
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
      icon: <MonitorUp size={15} />,
      ...(browserIsLive ? { badge: 'live' as const } : {})
    },
    terminal: {
      label: 'Terminal',
      description: "The agent's commands",
      icon: <SquareTerminal size={15} />,
      ...(terminalIsLive
        ? { badge: terminalIsWaiting ? ('waiting' as const) : ('live' as const) }
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
            <button type="button" className="activity-detached-focus" onClick={() => showApp(kind)}>
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
          />
        </div>
      )
    if (!active) return null
    if (kind === 'files')
      return (
        <FilesPanel
          workspaceFolder={workspaceFolder}
          isAgentBusy={isAgentBusy}
          fileRequest={fileRequest}
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
        className={`activity-panel ${isPinned ? 'is-pinned' : 'is-collapsed'}${isResizing && !isGliding ? ' is-resizing' : ''}${isGliding ? ' is-gliding' : ''}`}
        data-size={isPinned ? size : undefined}
        ref={panelRef}
        data-landing={landing ?? undefined}
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
            aria-valuemax={maxWidth ?? activityPanelMaximumWidth(window.innerWidth)}
            aria-valuenow={isPinned ? renderedWidth : 0}
            tabIndex={0}
            onPointerDown={beginResize}
            onDoubleClick={toggleSnapWidth}
            onKeyDown={resizeFromKeyboard}
            title={
              isPinned
                ? 'Drag to resize, across the window or shut · Double-click to switch width'
                : 'Drag to open'
            }
          />
        )}
        {landing &&
          createPortal(
            <div
              ref={phantomRef}
              className="activity-panel-phantom"
              data-landing={landing}
              aria-hidden="true"
            >
              {/* Remounted on each landing, so the edge and the icon pop as it settles. */}
              <span key={`edge-${landing}`} className="activity-panel-phantom-edge" />
              {(landing !== 'fold' || isPinned) && landing !== 'free' && (
                <span key={landing} className="activity-panel-phantom-icon">
                  {landing === 'fold' ? (
                    <PanelRightClose size={20} />
                  ) : landing === 'full' ? (
                    <Maximize2 size={20} />
                  ) : landing === 'narrow' ? (
                    <PanelRight size={20} />
                  ) : (
                    <Columns2 size={20} />
                  )}
                </span>
              )}
            </div>,
            document.body
          )}
        {isPinned ? (
          <div className="activity-content">
            <PanelSections
              layout={layout}
              apps={panelApps}
              onChange={setLayout}
              renderApp={renderApp}
              onFold={onTogglePin}
              onTearOut={tearOut}
              arriving={arriving}
              elsewhere={Object.fromEntries(
                [...detached].map((app) => [app, () => void showApp(app)])
              )}
            />
          </div>
        ) : (
          <div className="activity-collapsed-tabs">
            {familyRole && (
              <button
                className="activity-tab-vertical"
                onClick={() => openCollapsedTab('chats')}
                title={familyRole === 'manager' ? 'Open Chats' : 'Open Details'}
                aria-label={familyRole === 'manager' ? 'Open Chats' : 'Open Details'}
              >
                <Workflow size={16} />
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
              title="Open Browser activity"
              aria-label="Open Browser activity"
            >
              <MonitorUp size={16} />
              {browserIsLive && <span className="collapsed-tab-badge">Live</span>}
            </button>
            <button
              className="activity-tab-vertical"
              onClick={() => openCollapsedTab('terminal')}
              title="Open the agent's terminal"
              aria-label="Open the agent's terminal"
            >
              <SquareTerminal size={16} />
              {terminalIsLive && (
                <span className="collapsed-tab-badge">{terminalIsWaiting ? 'Input' : 'Live'}</span>
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
            />
          </div>
        )}
      </aside>
    </>
  )
}

export default ActivityPanel
