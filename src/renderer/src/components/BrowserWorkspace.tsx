import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  MessageSquarePlus
} from 'lucide-react'
import type {
  BrowserWorkspaceRequest,
  BrowserWorkspaceState
} from '../../../shared/browserWorkspace'
import { clipBrowserPanelBounds } from '../../../shared/browserPanelBounds'
import { webMcpSite } from '../../../shared/webMcp'
import { MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS } from '../../../shared/messageContextAttachments'
import './BrowserMarkChip.css'

/** The app's accent and the text it carries, so marks drawn over the page match the app. */
function accentColors(): { accent?: string; accentText?: string } {
  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--accent').trim()
  const accentText = style.getPropertyValue('--on-accent').trim()
  return { ...(accent ? { accent } : {}), ...(accentText ? { accentText } : {}) }
}

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
  const pageTools = state?.pageTools?.tools.length ? state.pageTools : null
  const hasPageTools = Boolean(pageTools)
  const annotating = Boolean(state?.annotating)
  const marks = useMemo(() => state?.annotations ?? [], [state?.annotations])
  // Notes as typed; each is saved when its field is left or Enter is pressed.
  const [notes, setNotes] = useState<Record<string, string>>({})
  const noteFields = useRef(new Map<string, HTMLInputElement>())
  const [focusMark, setFocusMark] = useState<string | null>(null)

  // A page that offers tools again later starts with its list closed.
  useEffect(() => {
    if (!hasPageTools) setToolsOpen(false)
  }, [hasPageTools])

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

  // A mark just made gets its note field; the main process reports errors from the page here.
  useEffect(
    () =>
      window.api.agentRuns.onBrowserAnnotationsChanged((change) => {
        if (change.conversationId !== conversationId) return
        if (change.error) setError(change.error)
        if (change.focus) setFocusMark(change.focus)
        void window.api.agentRuns
          .browserWorkspace({ conversationId, action: 'state' })
          .then((result) => result && setState(result))
          .catch(() => undefined)
      }),
    [conversationId]
  )

  useEffect(() => {
    if (!focusMark) return
    const field = noteFields.current.get(focusMark)
    if (!field) return
    field.focus()
    setFocusMark(null)
  }, [focusMark, marks])

  // Escape leaves a field without keeping what was typed in it.
  const discarding = useRef<string | null>(null)
  const saveNote = (id: string): void => {
    const note = notes[id]
    const discard = discarding.current === id
    discarding.current = null
    setNotes(({ [id]: _saved, ...rest }) => rest)
    const mark = marks.find((candidate) => candidate.id === id)
    if (discard || note === undefined || !mark || note === mark.note) return
    void window.api.agentRuns
      .browserWorkspace({ conversationId, action: 'annotationNote', annotationId: id, note })
      .then((result) => result && setState(result))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

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
            type="button"
            className="browser-workspace-tools"
            aria-label={`Tools this page offers the agent: ${pageTools.tools.length}`}
            aria-expanded={toolsOpen}
            aria-controls="browser-page-tools"
            title={`${webMcpSite(pageTools.origin)} offers ${pageTools.tools.length} ${
              pageTools.tools.length === 1 ? 'tool' : 'tools'
            } to the agent (WebMCP)`}
            onClick={() => setToolsOpen((open) => !open)}
          >
            <Plug size={14} aria-hidden="true" />
            <span>{pageTools.tools.length}</span>
          </button>
        )}
        <button
          type="button"
          className="browser-workspace-annotate"
          aria-pressed={annotating}
          aria-label={
            marks.length ? `Annotate the page, ${marks.length} marked` : 'Annotate the page'
          }
          disabled={!state}
          title={
            annotating
              ? 'Stop annotating (Esc). Your marks stay until you send them.'
              : 'Annotate: click an element or drag over an area, and write a note for the agent'
          }
          onClick={() => void act('annotate', { annotate: !annotating, ...accentColors() })}
        >
          <MessageSquarePlus size={15} aria-hidden="true" />
          {marks.length > 0 && <span>{marks.length}</span>}
        </button>
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
      {pageTools && toolsOpen && (
        // Laid out above the page, never over it: the page is drawn above the app.
        <section
          id="browser-page-tools"
          className="browser-workspace-page-tools"
          aria-label="Tools this page offers the agent"
        >
          <p className="browser-workspace-page-tools-heading">
            <strong>{webMcpSite(pageTools.origin)}</strong> offers these tools to the agent. Their
            descriptions are the site&apos;s own.
          </p>
          <ul>
            {pageTools.tools.map((tool) => (
              <li key={tool.name}>
                <div className="browser-workspace-page-tool-name">
                  <code>{tool.name}</code>
                  {tool.readOnly && (
                    <span className="browser-workspace-page-tool-mark">Read-only</span>
                  )}
                  {tool.form && <span className="browser-workspace-page-tool-mark">Form</span>}
                </div>
                <p title={tool.description}>{tool.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(error || layoutError) && (
        <div role="alert" className="browser-workspace-error">
          {error || layoutError}
        </div>
      )}
      <div
        ref={viewport}
        className={`browser-workspace-viewport${annotating ? ' is-annotating' : ''}`}
        aria-label="Live browser page"
      >
        {snapshot && (
          <img className="browser-workspace-snapshot" src={snapshot} alt="" aria-hidden="true" />
        )}
        {!state && (
          <p>
            Open a page above, or ask the agent to browse. You share the same tabs and page state.
          </p>
        )}
      </div>
      {(annotating || marks.length > 0) && (
        // Below the page, never over it: the page is drawn above the app.
        <section className="browser-workspace-annotations" aria-label="Marks for your next message">
          <p className="browser-workspace-annotations-hint">
            {annotating
              ? 'Click an element, or drag over an area, then write what should change. Esc stops.'
              : 'These marks go with your next message.'}
          </p>
          {marks.length > 0 && (
            <ol>
              {marks.map((mark) => (
                <li key={mark.id} className={mark.onPage ? undefined : 'is-elsewhere'}>
                  <span className="browser-mark-number" aria-hidden="true">
                    {mark.number}
                  </span>
                  <span className="browser-workspace-annotation-name" title={mark.name}>
                    {mark.name}
                  </span>
                  <input
                    ref={(field) => {
                      if (field) noteFields.current.set(mark.id, field)
                      else noteFields.current.delete(mark.id)
                    }}
                    aria-label={`Note for mark ${mark.number}, ${mark.name}`}
                    placeholder="What should change here?"
                    maxLength={MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS}
                    value={notes[mark.id] ?? mark.note}
                    onChange={(event) =>
                      setNotes((previous) => ({ ...previous, [mark.id]: event.target.value }))
                    }
                    onBlur={() => saveNote(mark.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        discarding.current = mark.id
                        event.currentTarget.blur()
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove mark ${mark.number}, ${mark.name}`}
                    title="Remove this mark"
                    onClick={() => void act('annotationRemove', { annotationId: mark.id })}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}
