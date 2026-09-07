import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Plus,
  X,
  Globe,
  Maximize2,
  Minimize2,
  Pause
} from 'lucide-react'
import type {
  BrowserWorkspaceRequest,
  BrowserWorkspaceState
} from '../../../shared/browserWorkspace'
import { clipBrowserPanelBounds } from '../../../shared/browserPanelBounds'

export function BrowserWorkspace({
  conversationId,
  onToggleWidth,
  isWide
}: {
  conversationId: string
  onToggleWidth?: () => void
  isWide?: boolean
}): React.JSX.Element {
  const [state, setState] = useState<BrowserWorkspaceState | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [layoutError, setLayoutError] = useState('')
  const [pending, setPending] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const editing = useRef(false)
  const activeUrl = state?.tabs.find((tab) => tab.active)?.url ?? ''

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
      document.querySelector('[role="dialog"], [aria-modal="true"]')
    const result = await window.api.agentRuns.browserWorkspace({
      conversationId,
      action: hidden ? 'unmount' : 'mount',
      ...(hidden ? {} : { bounds: bounds! })
    })
    setLayoutError('')
    if (!hidden)
      setState((previous) =>
        JSON.stringify(previous) === JSON.stringify(result) ? previous : result
      )
  }, [conversationId])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let running = false
    const update = async (): Promise<void> => {
      if (stopped || running) return
      running = true
      try {
        await refresh()
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
        {onToggleWidth && (
          <button
            className="browser-workspace-width"
            onClick={onToggleWidth}
            aria-label={isWide ? 'Restore browser panel width' : 'Widen browser panel'}
            title={isWide ? 'Restore browser panel width' : 'Widen browser panel'}
          >
            {isWide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
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
        {state?.verificationHandoff ? (
          <span
            className="browser-workspace-status"
            title="Finish the verification using the conversation handoff card"
            aria-label="Finish the verification using the conversation handoff card"
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
        {!state && (
          <p>
            Open a page above, or ask the agent to browse. You share the same tabs and page state.
          </p>
        )}
      </div>
    </div>
  )
}
