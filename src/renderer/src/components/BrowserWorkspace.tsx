import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Plus,
  X,
  Globe,
  Pause,
  Puzzle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  MessageSquarePlus,
  MoreHorizontal,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type {
  BrowserWorkspaceRequest,
  BrowserWorkspaceState
} from '../../../shared/browserWorkspace'
import { clipBrowserPanelBounds } from '../../../shared/browserPanelBounds'
import { webMcpSite } from '../../../shared/webMcp'
import type { BrowserSuggestion } from '../../../shared/browserLibrary'
import { BrowserImportDialog, BrowserSuggestions } from './BrowserLibrary'
import { BrowserMenu, type BrowserMenuCommand } from './BrowserMenu'
import { browserAddress } from '../../../shared/browserAddress'
import { DEFAULT_BROWSER_ZOOM } from '../../../shared/browserZoom'
import { BROWSER_RESPONSIVE_DEVICE } from '../../../shared/browserDevices'
import { useVoiceState } from '../hooks/useVoice'
import { startNoteDictation, type NoteDictation } from '../services/voice/noteDictation'
import './BrowserMarkChip.css'

/** The app's accent, the text it carries and its theme, so what is drawn over the page matches. */
function accentColors(): { accent?: string; accentText?: string; theme: 'dark' | 'light' } {
  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--accent').trim()
  const accentText = style.getPropertyValue('--on-accent').trim()
  return {
    ...(accent ? { accent } : {}),
    ...(accentText ? { accentText } : {}),
    theme: document.body.dataset.theme === 'light' ? 'light' : 'dark'
  }
}

export function BrowserWorkspace({
  conversationId,
  onOpenSettings,
  onPageShownChange
}: {
  conversationId: string
  /** Opens Settings where the browser's own settings are. */
  onOpenSettings?: () => void
  /** Whether the active tab shows a page, rather than an empty new tab. */
  onPageShownChange?: (shown: boolean) => void
}): React.JSX.Element {
  const [state, setState] = useState<BrowserWorkspaceState | null>(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [layoutError, setLayoutError] = useState('')
  const [pending, setPending] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  // The page is drawn above the app, so it hides while one of SideKick's menus is open; this
  // picture of it fills its place until the menu closes.
  const [snapshot, setSnapshot] = useState<{ image: string; zoom: number } | null>(null)
  const editing = useRef(false)
  const activeUrl = state?.tabs.find((tab) => tab.active)?.url ?? ''
  const pageShown = Boolean(activeUrl) && activeUrl !== 'about:blank'
  useEffect(() => {
    onPageShownChange?.(pageShown)
  }, [onPageShownChange, pageShown])
  // While an address is being opened, or the page is still loading.
  const loading = pending || Boolean(state?.tabs.find((tab) => tab.active)?.loading)
  // Shown only when the page is not at 100%, as a browser does.
  const zoomed =
    state?.zoom !== undefined && state.zoom !== DEFAULT_BROWSER_ZOOM ? state.zoom : null
  const [popover, setPopover] = useState<'tools' | 'menu' | null>(null)
  const toolsOpen = popover === 'tools'
  const [shownTool, setShownTool] = useState<string | null>(null)
  const toolsButton = useRef<HTMLButtonElement>(null)
  const toolsPopover = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [importOpen, setImportOpen] = useState(false)
  // Find in page: the text, and which match is selected of how many.
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [found, setFound] = useState<{ active: number; matches: number } | null>(null)
  const findField = useRef<HTMLInputElement>(null)
  const pageTools = state?.pageTools?.tools.length ? state.pageTools : null
  const toolsOrigin = pageTools?.origin ?? null
  const annotating = Boolean(state?.annotating)
  const voice = useVoiceState()
  const canDictate = Boolean(voice?.enabled && window.api?.voice)
  const marks = useMemo(() => state?.annotations ?? [], [state?.annotations])
  // What the user typed since focusing the address bar; null until they type.
  const [query, setQuery] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<BrowserSuggestion[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(-1)

  // Another site starts with the tools closed.
  useEffect(() => {
    setPopover((open) => (open === 'tools' ? null : open))
    setShownTool(null)
  }, [toolsOrigin])

  const closePopover = useCallback((focusButton: boolean): void => {
    setPopover((open) => {
      if (focusButton) (open === 'tools' ? toolsButton : menuButton).current?.focus()
      return null
    })
    setShownTool(null)
  }, [])

  useEffect(() => {
    if (!popover) return
    const button = popover === 'tools' ? toolsButton : menuButton
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element
      if (button.current?.contains(target)) return
      const inside =
        popover === 'tools'
          ? toolsPopover.current?.contains(target)
          : target.closest?.('.browser-workspace-menu')
      if (!inside) closePopover(false)
    }
    // The menu handles its own keys.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && popover === 'tools') closePopover(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    if (popover === 'tools') toolsPopover.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [popover, closePopover])

  const togglePopover = async (which: 'tools' | 'menu'): Promise<void> => {
    if (popover === which) {
      closePopover(false)
      return
    }
    // A popover opens over the page, which hides while it is open; a picture of the page fills
    // its place, so the picture comes first.
    const result = await window.api.agentRuns
      .browserWorkspace({ conversationId, action: 'snapshot' })
      .catch(() => null)
    if (result?.snapshot)
      setSnapshot({ image: result.snapshot, zoom: result.zoom ?? DEFAULT_BROWSER_ZOOM })
    setShownTool(null)
    setPopover(which)
  }

  useEffect(() => {
    if (!editing.current) setAddress(activeUrl)
  }, [activeUrl])

  // Imported bookmarks and history that match what the user types.
  useEffect(() => {
    setActiveSuggestion(-1)
    if (!query?.trim()) {
      setSuggestions([])
      return
    }
    let current = true
    const timer = setTimeout(() => {
      void window.api.browserLibrary
        .suggest(query)
        .then((list) => current && setSuggestions(list))
        .catch(() => current && setSuggestions([]))
    }, 60)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query])

  const refresh = useCallback(async () => {
    const element = viewport.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const bounds = clipBrowserPanelBounds(rect, window.innerWidth, window.innerHeight)
    const hidden =
      document.hidden ||
      !bounds ||
      element.closest('[hidden], [aria-hidden="true"]') ||
      document.querySelector('[role="dialog"], [aria-modal="true"], .app-menu') ||
      // A side panel tab is being dragged: the page would take the drag from the app.
      document.body.dataset.panelDrag === 'true'
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
      attributeFilter: ['hidden', 'aria-hidden', 'aria-modal', 'data-panel-drag']
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

  // The main process reports errors from the page here.
  useEffect(
    () =>
      window.api.agentRuns.onBrowserAnnotationsChanged((change) => {
        if (change.conversationId !== conversationId) return
        if (change.error) setError(change.error)
        void window.api.agentRuns
          .browserWorkspace({ conversationId, action: 'state' })
          .then((result) => result && setState(result))
          .catch(() => undefined)
      }),
    [conversationId]
  )

  // A note on the page asked for the microphone: this window listens, on this device, and hands
  // on what it hears. The page's overlay never holds the microphone itself.
  useEffect(() => {
    let dictation: Promise<NoteDictation | null> | null = null
    const report = (heard: NonNullable<BrowserWorkspaceRequest['dictation']>): void =>
      void window.api.agentRuns
        .browserWorkspace({ conversationId, action: 'annotationDictation', dictation: heard })
        .catch(() => undefined)
    const stopListening = (): void => {
      const current = dictation
      dictation = null
      void current?.then((active) => active?.stop()).then(() => report({ listening: false }))
    }
    const stop = window.api.agentRuns.onBrowserAnnotationsChanged((change) => {
      if (change.conversationId !== conversationId) return
      if (change.dictate === true && !dictation) {
        dictation = startNoteDictation((text, final) =>
          report({ listening: true, text, final })
        ).catch((e: unknown) => {
          dictation = null
          setError(e instanceof Error ? e.message : String(e))
          report({ listening: false })
          return null
        })
      } else if (change.dictate === false) stopListening()
    })
    return () => {
      stop()
      stopListening()
    }
  }, [conversationId])

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

  const find = async (text: string, next?: { forward: boolean }): Promise<void> => {
    const result = await window.api.agentRuns
      .browserWorkspace({
        conversationId,
        action: 'find',
        find: { text, ...(next ? { forward: next.forward, next: true } : {}) }
      })
      .catch(() => null)
    setFound(text ? (result?.found ?? { active: 0, matches: 0 }) : null)
  }
  const closeFind = (): void => {
    setFindOpen(false)
    setFindText('')
    setFound(null)
    void find('')
  }
  useEffect(() => {
    if (findOpen) findField.current?.focus()
  }, [findOpen])

  const runMenuCommand = (command: BrowserMenuCommand): void => {
    closePopover(false)
    if (command === 'find') {
      setFindOpen(true)
      findField.current?.select()
    } else if (command === 'print' || command === 'screenshot') {
      // The page shows again once the menu is gone, and only then is it printed or pictured.
      requestAnimationFrame(
        () =>
          void refresh()
            .catch(() => undefined)
            .then(() =>
              act(command, command === 'screenshot' ? { ...accentColors(), canDictate } : {})
            )
      )
    } else if (command === 'import') setImportOpen(true)
    else onOpenSettings?.()
  }

  const openAddress = (text: string): void => {
    editing.current = false
    setQuery(null)
    setAddress(text)
    // A page's address opens; anything else, such as a few words, is searched.
    const url = browserAddress(text)
    if (url) void act('url', { url })
  }
  const shownSuggestions = query === null ? [] : suggestions

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
                className="browser-workspace-tab-close"
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
          openAddress(shownSuggestions[activeSuggestion]?.url ?? address)
        }}
      >
        <span
          className={`browser-workspace-progress${loading ? ' is-loading' : ''}`}
          aria-hidden="true"
        />
        <div className="browser-workspace-nav" role="group" aria-label="Page navigation">
          <button
            type="button"
            aria-label="Go back"
            title="Back"
            disabled={!state?.canGoBack || pending || state.busy}
            onClick={() => void act('back')}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            aria-label="Go forward"
            title="Forward"
            disabled={!state?.canGoForward || pending || state.busy}
            onClick={() => void act('forward')}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            aria-label="Reload page"
            title="Reload"
            disabled={!state || pending || state.busy}
            onClick={() => void act('reload')}
          >
            <RotateCw size={14} />
          </button>
        </div>
        <div className="browser-workspace-address field-shell">
          <input
            aria-label="Browser address"
            aria-busy={loading}
            value={address}
            disabled={pending}
            placeholder="Search or enter an address"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={shownSuggestions.length > 0}
            aria-controls="browser-suggestions"
            aria-activedescendant={
              activeSuggestion >= 0 ? `browser-suggestions-${activeSuggestion}` : undefined
            }
            onFocus={(event) => {
              editing.current = true
              event.currentTarget.select()
            }}
            onBlur={() => {
              editing.current = false
              setQuery(null)
            }}
            onKeyDown={(event) => {
              if (!shownSuggestions.length) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                // Cycles through the suggestions and back to what was typed (-1).
                const step = event.key === 'ArrowDown' ? 1 : -1
                const states = shownSuggestions.length + 1
                setActiveSuggestion((index) => ((index + 1 + step + states) % states) - 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setQuery(null)
              }
            }}
            onChange={(event) => {
              setAddress(event.target.value)
              setQuery(event.target.value)
            }}
          />
          {state?.device && (
            <button
              type="button"
              className="browser-workspace-chip"
              aria-label={`${state.device.label}, ${state.device.width} × ${state.device.height}. Back to Responsive`}
              title={`${state.device.label}, ${state.device.width} × ${state.device.height}${
                state.device.source === 'agent' ? ', set by the agent' : ''
              }. Click to fit the page to the panel again.`}
              disabled={pending || state.busy}
              onClick={() => void act('device', { device: BROWSER_RESPONSIVE_DEVICE })}
            >
              {state.device.width} × {state.device.height}
            </button>
          )}
          {zoomed && (
            <button
              type="button"
              className="browser-workspace-chip"
              aria-label={`Page zoom ${zoomed}%. Reset to 100%`}
              title={`Zoomed to ${zoomed}%. Click for 100%; Ctrl + and Ctrl − on the page zoom it.`}
              onClick={() => void act('zoom', { zoomStep: 'reset' })}
            >
              {zoomed < DEFAULT_BROWSER_ZOOM ? (
                <ZoomOut size={12} aria-hidden="true" />
              ) : (
                <ZoomIn size={12} aria-hidden="true" />
              )}
              <span>{zoomed}%</span>
            </button>
          )}
        </div>
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
          onClick={() =>
            void act('annotate', { annotate: !annotating, ...accentColors(), canDictate })
          }
        >
          <MessageSquarePlus size={15} aria-hidden="true" />
          {marks.length > 0 && <span>{marks.length}</span>}
        </button>
        <div className="browser-workspace-anchor">
          <button
            ref={toolsButton}
            type="button"
            className="browser-workspace-tools"
            aria-label={
              pageTools
                ? `Tools this page offers the agent: ${pageTools.tools.length}`
                : 'Tools this page offers the agent'
            }
            aria-expanded={toolsOpen}
            aria-haspopup="dialog"
            aria-controls={toolsOpen ? 'browser-page-tools' : undefined}
            disabled={!state}
            title={
              pageTools
                ? `${webMcpSite(pageTools.origin)} offers the agent ${toolCount(pageTools.tools.length)}`
                : 'Page tools'
            }
            onClick={() => void togglePopover('tools')}
          >
            <Puzzle size={15} aria-hidden="true" />
            {pageTools && <span className="browser-workspace-tools-dot" aria-hidden="true" />}
          </button>
          {toolsOpen && (
            <section
              ref={toolsPopover}
              id="browser-page-tools"
              className="browser-workspace-page-tools"
              role="dialog"
              aria-label="Tools this page offers the agent"
              tabIndex={-1}
            >
              {pageTools ? (
                <>
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
                </>
              ) : (
                <p className="browser-workspace-page-tools-empty">
                  This page offers the agent no tools. Sites built for agents list theirs here.
                </p>
              )}
            </section>
          )}
        </div>
        <div className="browser-workspace-anchor">
          <button
            ref={menuButton}
            type="button"
            className="browser-workspace-more"
            aria-label="Browser menu"
            title="More"
            aria-haspopup="menu"
            aria-expanded={popover === 'menu'}
            disabled={!state}
            onClick={() => void togglePopover('menu')}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {popover === 'menu' && state && (
            <BrowserMenu
              zoom={state.zoom ?? DEFAULT_BROWSER_ZOOM}
              device={state.device}
              canScreenshot={!state.busy}
              onCommand={runMenuCommand}
              onZoom={(step) => void act('zoom', { zoomStep: step })}
              onDevice={(device) => {
                closePopover(false)
                void act('device', { device })
              }}
              onClose={closePopover}
            />
          )}
        </div>
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
      {findOpen && (
        <div className="browser-workspace-find" role="search" aria-label="Find in page">
          <div className="browser-workspace-find-field field-shell">
            <input
              ref={findField}
              value={findText}
              placeholder="Find in page"
              aria-label="Find in page"
              maxLength={500}
              onChange={(event) => {
                setFindText(event.target.value)
                void find(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (findText) void find(findText, { forward: !event.shiftKey })
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeFind()
                }
              }}
            />
            {found && (
              <span className="browser-workspace-find-count" aria-live="polite">
                {found.matches ? `${found.active} of ${found.matches}` : 'No matches'}
              </span>
            )}
          </div>
          <button
            type="button"
            aria-label="Previous match"
            title="Previous (Shift+Enter)"
            disabled={!found?.matches}
            onClick={() => void find(findText, { forward: false })}
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            aria-label="Next match"
            title="Next (Enter)"
            disabled={!found?.matches}
            onClick={() => void find(findText, { forward: true })}
          >
            <ChevronDown size={15} />
          </button>
          <button type="button" aria-label="Close find" title="Close (Esc)" onClick={closeFind}>
            <X size={14} />
          </button>
        </div>
      )}
      <BrowserImportDialog isOpen={importOpen} onClose={() => setImportOpen(false)} />
      {shownSuggestions.length > 0 && (
        <BrowserSuggestions
          id="browser-suggestions"
          suggestions={shownSuggestions}
          active={activeSuggestion}
          onPick={(suggestion) => openAddress(suggestion.url)}
        />
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
          // Zoomed while a menu covers it, the page's picture zooms too, so the step shows at once.
          <img
            className="browser-workspace-snapshot"
            src={snapshot.image}
            alt=""
            aria-hidden="true"
            style={{
              transform: `scale(${(state?.zoom ?? snapshot.zoom) / snapshot.zoom})`
            }}
          />
        )}
        {!state && <p>Open a page, or ask the agent to browse. You both use these tabs.</p>}
      </div>
    </div>
  )
}

function toolCount(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}
