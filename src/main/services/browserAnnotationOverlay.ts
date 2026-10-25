import type { BrowserWindow, IpcMain, IpcMainEvent, WebContentsView } from 'electron'
import { join } from 'path'
import type { BrowserPanelBounds } from '../../shared/browserWorkspace'
import {
  parseAnnotationOverlayMessage,
  type AnnotationOverlayMessage,
  type AnnotationOverlayState
} from '../../shared/annotationOverlay'

/**
 * The surface marks are made on. A live page is a native view the app cannot draw on, so while
 * the user annotates, a view of SideKick's own page covers it, as the agent's cursor does. The page
 * cannot see this view, draw above it, or read what is drawn on it. The overlay page has a preload
 * of its own with two calls: what to draw, and what the user did, which is checked here.
 */
export type BrowserAnnotationOverlayState = AnnotationOverlayState

/** What the user did on the overlay, in window pixels. */
export type BrowserAnnotationOverlayInput = AnnotationOverlayMessage

export interface BrowserAnnotationOverlayHandle {
  place(bounds: BrowserPanelBounds): void
  hide(): void
  readonly visible: boolean
  render(state: BrowserAnnotationOverlayState): void
}

// Each overlay's own handler, by the WebContents that may call it.
const listeners = new Map<number, (message: AnnotationOverlayMessage) => void>()
const readyListeners = new Map<number, () => void>()
let listening = false

function listen(ipcMain: IpcMain): void {
  if (listening) return
  listening = true
  ipcMain.on('annotationOverlay:message', (event: IpcMainEvent, raw: unknown) => {
    const message = parseAnnotationOverlayMessage(raw)
    if (message) listeners.get(event.sender.id)?.(message)
  })
  ipcMain.on('annotationOverlay:ready', (event: IpcMainEvent) =>
    readyListeners.get(event.sender.id)?.()
  )
}

/** Positions the overlay reports in its CSS pixels; the page's are in window pixels. */
function inWindowPixels(message: AnnotationOverlayMessage, zoom: number): AnnotationOverlayMessage {
  if (message.type === 'pointer') return { ...message, x: message.x * zoom, y: message.y * zoom }
  if (message.type === 'wheel')
    return {
      ...message,
      x: message.x * zoom,
      y: message.y * zoom,
      deltaX: message.deltaX * zoom,
      deltaY: message.deltaY * zoom
    }
  return message
}

function inOverlayPixels(state: AnnotationOverlayState, zoom: number): AnnotationOverlayState {
  const box = <T extends { x: number; y: number; width: number; height: number }>(value: T): T => ({
    ...value,
    x: value.x / zoom,
    y: value.y / zoom,
    width: value.width / zoom,
    height: value.height / zoom
  })
  return {
    ...state,
    marks: state.marks.map(box),
    ...(state.hover ? { hover: box(state.hover) } : {}),
    ...(state.drag ? { drag: box(state.drag) } : {})
  }
}

export async function createBrowserAnnotationOverlay(
  host: BrowserWindow,
  onInput: (input: BrowserAnnotationOverlayInput) => void
): Promise<BrowserAnnotationOverlayHandle> {
  // Electron is loaded here, not with the module, which loads with the IPC handlers.
  const { WebContentsView: View, app, ipcMain } = await import('electron')
  listen(ipcMain)
  const view: WebContentsView = new View({
    webPreferences: {
      preload: join(__dirname, '../preload/annotationOverlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Its own session: no storage shared with the app, and no zoom that follows the app's
      // origin, so its pixels map to the window's exactly.
      partition: 'sidekick-annotation-overlay'
    }
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  const contents = view.webContents
  // Its own document only: it never navigates or opens windows.
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const ready = (
    !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
      ? contents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/annotation-overlay.html`)
      : contents.loadFile(join(__dirname, '../renderer/annotation-overlay.html'))
  )
    .then(() => true)
    .catch(() => false)
  let visible = false
  let latest: BrowserAnnotationOverlayState | undefined
  // The overlay's controls follow the app's own size, as the rest of SideKick does.
  const zoom = (): number => (host.isDestroyed() ? 1 : host.webContents.getZoomFactor() || 1)
  const draw = (): void => {
    if (!latest || contents.isDestroyed()) return
    const factor = zoom()
    if (Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor)
    contents.send('annotationOverlay:state', inOverlayPixels(latest, factor))
  }
  listeners.set(contents.id, (message) => {
    if (visible) onInput(inWindowPixels(message, zoom()))
  })
  readyListeners.set(contents.id, draw)
  contents.once('destroyed', () => {
    listeners.delete(contents.id)
    readyListeners.delete(contents.id)
  })
  host.once('closed', () => {
    if (!contents.isDestroyed()) contents.close()
  })
  void ready
  return {
    get visible() {
      return visible
    },
    place(bounds) {
      if (host.isDestroyed() || contents.isDestroyed()) return
      const children = host.contentView.children
      // Adding a view it already holds raises it above the page, which may have been re-added.
      if (!visible || children[children.length - 1] !== view) host.contentView.addChildView(view)
      view.setBounds(bounds)
      view.setVisible(true)
      if (!visible) contents.focus()
      visible = true
    },
    hide() {
      visible = false
      if (!contents.isDestroyed()) view.setVisible(false)
    },
    render(state) {
      latest = state
      void ready.then((loaded) => loaded && draw())
    }
  }
}
