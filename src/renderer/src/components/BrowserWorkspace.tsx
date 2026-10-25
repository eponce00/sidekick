import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Plus,
  X,
  Globe,
  MonitorSmartphone,
  Pause,
  Plug,
  ChevronRight
} from 'lucide-react'
import type {
  BrowserWorkspaceRequest,
  BrowserWorkspaceState
} from '../../../shared/browserWorkspace'
import { clipBrowserPanelBounds } from '../../../shared/browserPanelBounds'
import { webMcpSite } from '../../../shared/webMcp'

export function BrowserWorkspace({
  conversationId
}: {
  conversationId: string
}): React.JSX.Element {
  const [state, setState] = useState<BrowserWorkspaceState | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [layoutError, setLayoutError] = useState('')
  const [pending, setPending] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  // The page is drawn above the app, so it hides while one of SideKick's menus is open; this
  // picture of it fills its place until the menu closes.
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const editing = useRef(false)
  const activeUrl = state?.tabs.find((tab) => tab.active)?.url ?? ''
  const [toolsOpen, setToolsOpen] = useState(false)
  const [shownTool, setShownTool] = useState<string | null>(null)
  const toolsButton = useRef<HTMLButtonElement>(null)
  const toolsPopover = useRef<HTMLElement>(null)
  const pageTools = state?.pageTools?.tools.length ? state.pageTools : null
  const toolsOrigin = pageTools?.origin ?? null

  // Another site, or a page without tools, starts with the popover closed.
  useEffect(() => {
    setToolsOpen(false)
    setShownTool(null)
  }, [toolsOrigin])

  useEffect(() => {
    if (!toolsOpen) return
    const close = (focusButton: boolean): void => {
      setToolsOpen(false)
      setShownTool(null)
      if (focusButton) toolsButton.current?.focus()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!toolsPopover.current?.contains(target) && !toolsButton.current?.contains(target))
        close(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    toolsPopover.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [toolsOpen])

  const toggleTools = async (): Promise<void> => {
    if (toolsOpen) {
      setToolsOpen(false)
      setShownTool(null)
      return
    }
    // The popover opens over the page, which hides while it is open; a picture of the page fills
    // its place, so the picture comes first.
    const result = await window.api.agentRuns
      .browserWorkspace({ conversationId, action: 'snapshot' })
      .catch(() => null)
    if (result?.snapshot) setSnapshot(result.snapshot)
    setToolsOpen(true)
  }

  useEffect(() => {
    if (!editing.current) setAddress(activeUrl)
  }, [activeUrl])

  const refresh = useCallback(async () => {
    const element = viewport.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const bounds = clipBrowserPanelBounds(rect, window.innerWidth, window.innerHeight)
    const hidden =
      document.hidden ||
      !bounds ||
      element.closest('[hidden], [aria-hidden="true"]') ||
      document.querySelector('[role="dialog"], [aria-modal="true"], .app-menu')
    const result = await window.api.agentRuns.browserWorkspace({
      conversationId,
      action: hidden ? 'unmount' : 'mount',
      ...(hidden ? {} : { bounds: bounds! })
    })
    setLayoutError('')
    if (!hidden) setSnapshot(null)
    if (!hidden)
      setState((previous) =>
        JSON.stringify(previous) === JSON.stringify(result) ? previous : result
      )
  }, [conversationId])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let running = false
    let again = false
    // While the panel animates, the page view must follow every step. A change during an update
    // runs one more update afterwards, so the view always ends at the latest bounds instead of
    // waiting for the next poll.
    const update = async (): Promise<void> => {
      if (stopped) return
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          await refresh()
        } while (again && !stopped)
      } catch (e) {
        if (!stopped) setLayoutError(String(e))
      } finally {
        running = false
      }
    }
    const poll = async (): Promise<void> => {
      await update()
      if (!stopped) timer = setTimeout(() => void poll(), 350)
    }
    const resize = new ResizeObserver(() => void update())
    const overlays = new MutationObserver(() => void update())
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'aria-modal']
    })
    if (viewport.current) resize.observe(viewport.current)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('resize', update)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      resize.disconnect()
      overlays.disconnect()
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('resize', update)
      void window.api.agentRuns.browserWorkspace({ conversationId, action: 'unmount' })
    }
  }, [conversationId, refresh])

  const act = async (
    action: BrowserWorkspaceRequest['action'],
    extra: Partial<BrowserWorkspaceRequest> = {}
  ): Promise<void> => {
    setPending(true)
    setError('')
    try {
      setState(await window.api.agentRuns.browserWorkspace({ conversationId, action, ...extra }))
      await refresh().catch((e) => setLayoutError(String(e)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="browser-workspace">
      <div className="browser-workspace-topbar">
        <div className="browser-workspace-tabs" role="tablist" aria-label="Browser tabs">
          {!state?.tabs.length && (
            <span className="browser-workspace-new-label">
              <Globe size={15} />
              New tab
            </span>
          )}
          {state?.tabs.map((tab) => (
            <div key={tab.id} className="browser-workspace-tab">
              <button
                role="tab"
                aria-selected={tab.active}
                title={tab.url}
                disabled={pending || state.busy}
                onClick={() => void act('select', { tabId: tab.id })}
              >
                <Globe size={13} aria-hidden="true" />
                <span>{tab.title || 'New tab'}</span>
              </button>
              <button
                aria-label={`Close ${tab.title || 'tab'}`}
                disabled={pending || state.busy}
                onClick={() => void act('close', { tabId: tab.id })}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            aria-label="New browser tab"
            disabled={pending || state?.busy}
            onClick={() => void act('new')}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <form
        className="browser-workspace-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          editing.current = false
          void act('url', {
            url: /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`
          })
        }}
      >
        <button
          type="button"
          aria-label="Go back"
          disabled={!state?.canGoBack || pending || state.busy}
          onClick={() => void act('back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          aria-label="Go forward"
          disabled={!state?.canGoForward || pending || state.busy}
          onClick={() => void act('forward')}
        >
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          aria-label="Reload page"
          disabled={!state || pending || state.busy}
          onClick={() => void act('reload')}
        >
          <RotateCw size={14} />
        </button>
        {/* Page tools sit inside the address field, like a browser's page actions, so the field
            and the page never move when a page offers them. */}
        <div className={`browser-workspace-address${pageTools ? ' has-tools' : ''}`}>
          <input
            aria-label="Browser address"
            value={address}
            disabled={pending}
            placeholder="Enter a URL"
            onFocus={() => {
              editing.current = true
            }}
            onBlur={() => {
              editing.current = false
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
          {pageTools && (
            <button
              ref={toolsButton}
              type="button"
              className="browser-workspace-tools"
              aria-label={`Tools this page offers the agent: ${pageTools.tools.length}`}
              aria-expanded={toolsOpen}
              aria-haspopup="dialog"
              aria-controls={toolsOpen ? 'browser-page-tools' : undefined}
              title={`${webMcpSite(pageTools.origin)} offers the agent ${toolCount(
                pageTools.tools.length
              )}`}
              onClick={() => void toggleTools()}
            >
              <Plug size={13} aria-hidden="true" />
            </button>
          )}
          {pageTools && toolsOpen && (
            <section
              ref={toolsPopover}
              id="browser-page-tools"
              className="browser-workspace-page-tools"
              role="dialog"
              aria-label="Tools this page offers the agent"
              tabIndex={-1}
            >
              <header>
                <strong>{webMcpSite(pageTools.origin)}</strong>
                <span>offers the agent {toolCount(pageTools.tools.length)}</span>
              </header>
              <ul>
                {pageTools.tools.map((tool, index) => {
                  const shown = shownTool === tool.name
                  return (
                    <li key={tool.name}>
                      <button
                        type="button"
                        aria-expanded={shown}
                        aria-controls={shown ? `browser-page-tool-${index}` : undefined}
                        onClick={() => setShownTool(shown ? null : tool.name)}
                      >
                        <ChevronRight size={12} aria-hidden="true" />
                        <code>{tool.name}</code>
                        {tool.readOnly && (
                          <span className="browser-workspace-page-tool-mark">Read-only</span>
                        )}
                        {tool.form && (
                          <span className="browser-workspace-page-tool-mark">Form</span>
                        )}
                      </button>
                      {shown && (
                        // The site's own words, set apart as a quote and shown as text.
                        <blockquote id={`browser-page-tool-${index}`}>
                          {tool.description || 'The site gives no description.'}
                        </blockquote>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
        <button
          type="button"
          className={`browser-workspace-device${state?.device ? ' is-fixed' : ''}`}
          aria-label="Device size"
          disabled={!state || pending || state.busy}
          title={
            state?.device
              ? `${state.device.label}, ${state.device.width} × ${state.device.height}${
                  state.device.source === 'agent' ? ', set by the agent' : ''
                }. Choose a size, or Responsive to fit the panel.`
              : 'Responsive: the page fits the panel. Choose a phone, tablet, laptop, or desktop size.'
          }
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            void window.api.agentRuns
              .browserWorkspace({
                conversationId,
                action: 'deviceMenu',
                menuPosition: { x: rect.left, y: rect.bottom + 4 }
              })
              .then((result) => {
                if (result?.snapshot && document.querySelector('.app-menu'))
                  setSnapshot(result.snapshot)
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }}
        >
          <MonitorSmartphone size={15} aria-hidden="true" />
          {state?.device && (
            <span>
              {state.device.width} × {state.device.height}
            </span>
          )}
        </button>
        {state?.waitingForUser ? (
          <span
            className="browser-workspace-status is-waiting"
            title="The agent continues once you finish this page's check"
            aria-label="The agent continues once you finish this page's check"
          >
            <Pause size={14} />
          </span>
        ) : state?.busy ? (
          <span
            className="browser-workspace-status"
            aria-label="Agent is using this page"
            title="Agent is using this page"
          >
            <span className="browser-workspace-live-dot" />
          </span>
        ) : null}
      </form>
      {(error || layoutError) && (
        <div role="alert" className="browser-workspace-error">
          {error || layoutError}
        </div>
      )}
      <div ref={viewport} className="browser-workspace-viewport" aria-label="Live browser page">
        {snapshot && (
          <img className="browser-workspace-snapshot" src={snapshot} alt="" aria-hidden="true" />
        )}
        {!state && (
          <p>
            Open a page above, or ask the agent to browse. You share the same tabs and page state.
          </p>
        )}
      </div>
    </div>
  )
}

function toolCount(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}
