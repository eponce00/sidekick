import type { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserPanelBounds } from '../../shared/browserWorkspace'

interface HostedView {
  view: WebContentsView
  parking: BrowserWindow
  host?: BrowserWindow
  allowInput?: () => boolean
  agentInput: number
  /** App zoom the embedded page is rendered at; 1 whenever the view is parked. */
  zoom: number
  /**
   * A fixed viewport. The page lays out at exactly its width, unaffected by app zoom, and is
   * drawn scaled down to fit the panel while shown in the app.
   */
  agentViewport?: BrowserAgentViewport
  applyFit?: (layout: BrowserViewportFit) => Promise<void>
  /** The scale and laid-out height in effect; scale 1 and the requested height when parked. */
  fit: number
  fitHeight: number
  /** Where the panel is, while shown; the page may take a centred part of it. */
  panelBounds?: BrowserPanelBounds
}

export interface BrowserAgentViewport {
  width: number
  height: number
  /**
   * A desktop-like size grows its height to fill the panel at the width's scale, as a tall
   * window would; a phone or tablet keeps its exact size and is centred.
   */
  fillHeight: boolean
}

export interface BrowserViewportFit {
  scale: number
  /** The height the page lays out at, in CSS pixels. */
  height: number
}

function pageZoom(entry: HostedView): number {
  return entry.agentViewport ? 1 : entry.zoom
}

/** How a fixed viewport sits in the panel: its scale, laid-out height, and the view's rectangle. */
function agentLayout(
  entry: HostedView
): (BrowserViewportFit & { bounds?: BrowserPanelBounds }) | undefined {
  const viewport = entry.agentViewport
  if (!viewport) return undefined
  const panel = entry.host ? entry.panelBounds : undefined
  if (!panel) return { scale: 1, height: viewport.height }
  const scale = viewport.fillHeight
    ? Math.min(1, panel.width / viewport.width)
    : Math.min(1, panel.width / viewport.width, panel.height / viewport.height)
  const height = viewport.fillHeight
    ? Math.max(viewport.height, Math.floor(panel.height / scale))
    : viewport.height
  const width = Math.min(panel.width, Math.round(viewport.width * scale))
  const shown = Math.min(panel.height, Math.round(height * scale))
  return {
    scale,
    height,
    bounds: {
      x: panel.x + Math.floor((panel.width - width) / 2),
      y: panel.y + Math.floor((panel.height - shown) / 2),
      width,
      height: shown
    }
  }
}

/** Brings the page's zoom, and a fixed viewport's scale, height and place, in line with where it is. */
async function relayout(entry: HostedView, force = false): Promise<void> {
  applyViewZoom(entry)
  const layout = agentLayout(entry)
  if (entry.host && entry.panelBounds) entry.view.setBounds(layout?.bounds ?? entry.panelBounds)
  if (!layout || !entry.applyFit) return
  if (!force && Math.abs(layout.scale - entry.fit) < 0.001 && layout.height === entry.fitHeight)
    return
  entry.fit = layout.scale
  entry.fitHeight = layout.height
  await entry.applyFit({ scale: layout.scale, height: layout.height })
}

/** Embedded bounds arrive in physical window pixels, so a view left at zoom 1
 * renders the page larger than the surrounding app UI. Matching the host zoom
 * keeps page content on the same scale as everything around it. */
function applyViewZoom(entry: HostedView): void {
  const contents = entry.view.webContents
  if (contents.isDestroyed()) return
  const zoom = pageZoom(entry)
  if (Math.abs(contents.getZoomFactor() - zoom) > 0.001) contents.setZoomFactor(zoom)
}

// Only main-process-created isolated tabs can be embedded; renderer IDs are never accepted.
const views = new Map<number, HostedView>()
const watchedHosts = new WeakSet<BrowserWindow>()

export function registerBrowserView(view: WebContentsView, parking: BrowserWindow): void {
  const entry: HostedView = { view, parking, agentInput: 0, zoom: 1, fit: 1, fitHeight: 0 }
  const id = view.webContents.id
  views.set(id, entry)
  // Chromium keeps zoom per origin, so a cross-origin navigation drops the zoom
  // we applied on mount. Re-apply it once the new document is committed.
  view.webContents.on('did-navigate', () => applyViewZoom(entry))
  view.webContents.on('before-input-event', (event) => {
    if (!entry.agentInput && entry.host && entry.allowInput && !entry.allowInput())
      event.preventDefault()
  })
  view.webContents.on('context-menu', async (_event, params) => {
    const host = entry.host
    const contents = view.webContents
    const canUseMenu = (): boolean =>
      Boolean(
        host &&
        views.get(id) === entry &&
        entry.host === host &&
        !host.isDestroyed() &&
        !contents.isDestroyed() &&
        entry.allowInput?.()
      )
    if (!canUseMenu()) return
    const { Menu } = await import('electron')
    if (!canUseMenu()) return
    const guarded =
      (action: () => void): (() => void) =>
      () => {
        if (canUseMenu()) action()
      }
    Menu.buildFromTemplate([
      { label: 'Cut', enabled: params.editFlags.canCut, click: guarded(() => contents.cut()) },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: guarded(() => contents.copy()) },
      {
        label: 'Paste',
        enabled: params.editFlags.canPaste,
        click: guarded(() => contents.paste())
      },
      { type: 'separator' },
      {
        label: 'Select all',
        enabled: params.editFlags.canSelectAll,
        click: guarded(() => contents.selectAll())
      }
    ]).popup({ window: host })
  })
  view.webContents.on('before-mouse-event', (event, input) => {
    if (
      !entry.agentInput &&
      input.type !== 'mouseMove' &&
      entry.host &&
      entry.allowInput &&
      !entry.allowInput()
    ) {
      event.preventDefault()
    }
  })
  view.webContents.once('destroyed', () => views.delete(id))
}

export function mountBrowserView(
  id: number,
  host: BrowserWindow,
  bounds: BrowserPanelBounds,
  allowInput: () => boolean,
  zoom = 1
): void {
  const entry = views.get(id)
  if (!entry || host.isDestroyed()) throw new Error('Browser page is no longer available')
  for (const [otherId, other] of views) {
    if (otherId !== id && other.host === host) parkBrowserView(otherId)
  }
  if (entry.host !== host) {
    ;(entry.host ?? entry.parking).contentView.removeChildView(entry.view)
    host.contentView.addChildView(entry.view)
    entry.parking.hide()
    entry.host = host
    if (!watchedHosts.has(host)) {
      watchedHosts.add(host)
      host.once('closed', () => unmountBrowserHost(host))
    }
  }
  entry.allowInput = allowInput
  entry.zoom = zoom
  entry.panelBounds = bounds
  entry.view.setVisible(true)
  void relayout(entry).catch(() => undefined)
}

/**
 * Sets or clears the viewport the agent asked for. Returns false for a page that is not an
 * embeddable view, which keeps its natural scale. `applyFit` sets the page's emulated metrics at
 * the scale it is drawn at.
 */
export async function setBrowserViewAgentViewport(
  id: number,
  viewport: BrowserAgentViewport | null,
  applyFit: (layout: BrowserViewportFit) => Promise<void>
): Promise<boolean> {
  const entry = views.get(id)
  if (!entry) return false
  entry.agentViewport = viewport ?? undefined
  entry.applyFit = viewport ? applyFit : undefined
  if (!viewport) {
    entry.fit = 1
    entry.fitHeight = 0
    applyViewZoom(entry)
    if (entry.host && entry.panelBounds) entry.view.setBounds(entry.panelBounds)
    return true
  }
  await relayout(entry, true)
  return true
}

export function parkBrowserView(id: number): void {
  const entry = views.get(id)
  if (!entry?.host) return
  hidePointer(entry.host)
  if (!entry.host.isDestroyed()) entry.host.contentView.removeChildView(entry.view)
  entry.host = undefined
  entry.panelBounds = undefined
  entry.allowInput = undefined
  // Parked views back automation and human takeover, which size the page from
  // the parking window itself, so they belong at natural scale.
  entry.zoom = 1
  if (!entry.parking.isDestroyed() && !entry.view.webContents.isDestroyed()) {
    entry.parking.contentView.addChildView(entry.view)
    const [width, height] = entry.parking.getContentSize()
    entry.view.setBounds({ x: 0, y: 0, width, height })
    void relayout(entry).catch(() => undefined)
    entry.parking.setOpacity(process.platform === 'darwin' ? 0.01 : 1)
    entry.parking.showInactive()
  }
}

export function unmountBrowserHost(host: BrowserWindow): void {
  for (const [id, entry] of views) if (entry.host === host) parkBrowserView(id)
}

/**
 * Whether a window only holds a browser page out of sight. It keeps the page rendering for the
 * agent, so it is shown off screen, but it is not a window the user has open.
 */
export function isBrowserParkingWindow(window: BrowserWindow): boolean {
  for (const entry of views.values()) if (entry.parking === window) return true
  return false
}

export function browserViewHost(id: number): BrowserWindow | undefined {
  return views.get(id)?.host
}

export function browserNavigationState(id: number): { canGoBack: boolean; canGoForward: boolean } {
  const contents = views.get(id)?.view.webContents
  return {
    canGoBack: Boolean(
      contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()
    ),
    canGoForward: Boolean(
      contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()
    )
  }
}

// The agent's cursor. A live page is a native view the app UI cannot draw on,
// so the cursor is its own small transparent view floated above the page at the
// point of each gesture. It never enters the page, so the page's DOM and the
// model's screenshots stay untouched. A native view takes the mouse, so it is
// only as large as the cursor and hides again once its pulse has played.
const POINTER_SIZE = 96
const POINTER_TIP = 40
const POINTER_VISIBLE_MS = 2_400
const POINTER_PAGE = `<!doctype html><html><head><style>
html,body{margin:0;background:transparent;overflow:hidden;user-select:none}
#p{position:absolute;left:${POINTER_TIP}px;top:${POINTER_TIP}px;width:0;height:0;color:#62a9ff;
animation:fade ${POINTER_VISIBLE_MS}ms linear both}
#p svg{position:absolute;z-index:2;top:-4px;left:-4px;overflow:visible;
filter:drop-shadow(0 0 1px rgba(255,255,255,.98)) drop-shadow(0 2px 3px rgba(0,0,0,.9)) drop-shadow(0 0 6px rgba(56,146,255,.9))}
#p:before{position:absolute;top:-21px;left:-21px;width:42px;height:42px;content:'';
background:rgba(55,144,255,.34);border-radius:50%;filter:blur(8px)}
#p:after{position:absolute;top:-16px;left:-16px;width:30px;height:30px;content:'';
border:2px solid rgba(104,177,255,.88);border-radius:50%;opacity:0;animation:pulse 1.2s ease-out 1 both}
@keyframes pulse{from{opacity:.9;transform:scale(.35)}to{opacity:0;transform:scale(1.25)}}
@keyframes fade{0%,80%{opacity:1}to{opacity:0}}
@media (prefers-reduced-motion:reduce){#p:after{animation:none}}
</style></head><body><script>
window.showPointer=()=>{document.getElementById('p')?.remove();const p=document.createElement('span');p.id='p';
p.innerHTML='<svg width="27" height="27" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';
document.body.append(p)}
</script></body></html>`

interface PointerOverlay {
  view: WebContentsView
  ready: Promise<unknown>
  hideTimer?: ReturnType<typeof setTimeout>
}

const pointerOverlays = new WeakMap<BrowserWindow, PointerOverlay>()

async function pointerOverlay(host: BrowserWindow): Promise<PointerOverlay> {
  const existing = pointerOverlays.get(host)
  if (existing && !existing.view.webContents.isDestroyed()) return existing
  const { WebContentsView: View } = await import('electron')
  const view = new View({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  const overlay: PointerOverlay = {
    view,
    ready: view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(POINTER_PAGE)}`)
      .catch(() => undefined)
  }
  pointerOverlays.set(host, overlay)
  host.once('closed', () => {
    if (overlay.hideTimer) clearTimeout(overlay.hideTimer)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  })
  return overlay
}

function hidePointer(host: BrowserWindow | undefined): void {
  const overlay = host && pointerOverlays.get(host)
  if (!overlay) return
  if (overlay.hideTimer) clearTimeout(overlay.hideTimer)
  overlay.hideTimer = undefined
  if (!overlay.view.webContents.isDestroyed()) overlay.view.setVisible(false)
}

/**
 * Shows the agent's cursor at a point in the page's CSS viewport pixels, while
 * the page is shown inside the app. A parked page has no one watching it.
 */
export async function showBrowserPointer(id: number, x: number, y: number): Promise<void> {
  const entry = views.get(id)
  const host = entry?.host
  if (!entry || !host || host.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
  const bounds = entry.view.getBounds()
  // CSS pixels reach the panel scaled by the app zoom, or by the fit of an agent viewport.
  const scale = entry.agentViewport ? entry.fit : entry.zoom
  const left = bounds.x + x * scale
  const top = bounds.y + y * scale
  if (left < bounds.x || top < bounds.y || left > bounds.x + bounds.width) return
  if (top > bounds.y + bounds.height) return
  const overlay = await pointerOverlay(host)
  await overlay.ready
  // The page may have been parked or moved to another window meanwhile.
  if (entry.host !== host || host.isDestroyed() || overlay.view.webContents.isDestroyed()) return
  // Adding a view it already holds raises it above the page.
  host.contentView.addChildView(overlay.view)
  overlay.view.setBounds({
    x: Math.round(left - POINTER_TIP),
    y: Math.round(top - POINTER_TIP),
    width: POINTER_SIZE,
    height: POINTER_SIZE
  })
  overlay.view.setVisible(true)
  await overlay.view.webContents.executeJavaScript('window.showPointer()').catch(() => undefined)
  if (overlay.hideTimer) clearTimeout(overlay.hideTimer)
  overlay.hideTimer = setTimeout(() => hidePointer(host), POINTER_VISIBLE_MS)
}

/** Marks a main-process tool gesture so its synthetic input is not treated as user takeover. */
export async function browserAgentInput<T>(
  id: number,
  operation: () => T | Promise<T>
): Promise<T> {
  const entry = views.get(id)
  if (entry) entry.agentInput++
  try {
    return await operation()
  } finally {
    if (entry) entry.agentInput--
  }
}

/** Only CDP input injection owns an input exemption. Read-only debugger requests
 * can be slow and must not mask real user input while their promises are pending. */
export function browserDebuggerCommand<T>(
  id: number,
  method: string,
  operation: () => Promise<T>
): Promise<T> {
  return method.startsWith('Input.') ? browserAgentInput(id, operation) : operation()
}
