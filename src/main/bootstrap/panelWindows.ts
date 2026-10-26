import {
  BrowserWindow,
  screen,
  systemPreferences,
  type Rectangle,
  type WebContents
} from 'electron'
import { join } from 'path'
import icon from '../../../resources/icon.png?asset'
import { appState } from '../ipc/state'
import { desktopPlatform } from '../../shared/platform'
import type { PanelWindowEntry } from '../../shared/panelWindows'
import { mainWindowChrome } from './windowChrome'
import { installAppWindowGuards, loadAppPage } from './appWindowGuards'
import type { TextScaleSetting } from './windowZoom'

const WIDTH = 560
const HEIGHT = 760
const MIN_WIDTH = 360
const MIN_HEIGHT = 320
const MOTION_MS = 220

/** The system's own setting for interface motion; without it a window just appears or goes. */
function motionAllowed(): boolean {
  try {
    return systemPreferences.getAnimationSettings().shouldRenderRichAnimation
  } catch {
    return true
  }
}

/**
 * Moves and fades a window between two rectangles, easing out, so it reads as coming from or going
 * to a place. Resolves at once when the system asks for less motion.
 */
function glide(
  window: BrowserWindow,
  from: Rectangle,
  to: Rectangle,
  opacity: [number, number]
): Promise<void> {
  if (!motionAllowed() || window.isDestroyed()) return Promise.resolve()
  // A window may not shrink below its minimum while it glides through small sizes.
  window.setMinimumSize(1, 1)
  const started = Date.now()
  return new Promise((resolve) => {
    const step = (): void => {
      if (window.isDestroyed()) return resolve()
      const t = Math.min(1, (Date.now() - started) / MOTION_MS)
      const eased = 1 - (1 - t) ** 3
      const mix = (a: number, b: number): number => Math.round(a + (b - a) * eased)
      window.setBounds({
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        width: mix(from.width, to.width),
        height: mix(from.height, to.height)
      })
      window.setOpacity(opacity[0] + (opacity[1] - opacity[0]) * eased)
      if (t < 1) setTimeout(step, 16)
      else resolve()
    }
    step()
  })
}

/** A small rectangle centred on a point, where a window starts or ends its glide. */
function seed(at: { x: number; y: number }, size: { width: number; height: number }): Rectangle {
  const width = Math.round(size.width * 0.35)
  const height = Math.round(size.height * 0.35)
  return { x: at.x - Math.round(width / 2), y: at.y - Math.round(height / 2), width, height }
}

const windows = new Map<string, { window: BrowserWindow; entry: PanelWindowEntry }>()
const keyOf = (entry: PanelWindowEntry): string => `${entry.conversationId}\n${entry.app}`

export function panelWindowEntries(): PanelWindowEntry[] {
  return [...windows.values()].map(({ entry }) => entry)
}

function publish(): void {
  const contents = appState.mainWindowRef?.webContents
  if (contents && !contents.isDestroyed())
    contents.send('panelWindows:changed', panelWindowEntries())
}

/** The panel window a page belongs to, if it is one. */
export function panelWindowFor(contents: WebContents): PanelWindowEntry | undefined {
  for (const { window, entry } of windows.values())
    if (!window.isDestroyed() && window.webContents === contents) return entry
  return undefined
}

export function focusPanelWindow(entry: PanelWindowEntry): boolean {
  const open = windows.get(keyOf(entry))?.window
  if (!open || open.isDestroyed()) return false
  if (open.isMinimized()) open.restore()
  open.focus()
  return true
}

/**
 * Opens an app of the main window's panel in a window of its own, centred under the point where
 * its tab was let go and kept on that screen. An app already in its own window comes to the front.
 */
export function openPanelWindow(
  entry: PanelWindowEntry,
  point: { x?: number; y?: number },
  textScale: TextScaleSetting
): void {
  if (focusPanelWindow(entry)) return
  const platform = desktopPlatform(process.platform)
  const at =
    Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: Math.round(point.x!), y: Math.round(point.y!) }
      : screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(at).workArea
  const width = Math.min(WIDTH, area.width)
  const height = Math.min(HEIGHT, area.height)
  const bounds: Rectangle = {
    width,
    height,
    x: Math.min(Math.max(area.x, at.x - Math.round(width / 2)), area.x + area.width - width),
    y: Math.min(Math.max(area.y, at.y - 20), area.y + area.height - height)
  }
  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: platform !== 'macos',
    ...mainWindowChrome(platform),
    title: 'SideKick',
    backgroundColor: '#131313',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  })
  // Its page is the app's own, so it gets the main window's guards. It shares the main window's
  // session, whose permission handler gives the microphone to the main window's page only.
  installAppWindowGuards(window, platform, textScale)
  const key = keyOf(entry)
  windows.set(key, { window, entry })
  // It grows out of the place the tab was let go.
  window.on('ready-to-show', () => {
    const start = seed(at, bounds)
    if (motionAllowed()) {
      window.setOpacity(0)
      window.setMinimumSize(1, 1)
      window.setBounds(start)
    }
    window.showInactive()
    window.focus()
    void glide(window, start, bounds, [0, 1]).then(() => {
      if (!window.isDestroyed()) window.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
    })
  })
  window.on('closed', () => {
    if (windows.get(key)?.window === window) windows.delete(key)
    publish()
  })
  loadAppPage(window, { panel: entry.app, conversation: entry.conversationId })
  publish()
}

/**
 * Puts a panel window's app back in the main window's panel: the window glides into the main
 * window's side, where the panel is, and the tab appears there as it closes.
 */
export function dockPanelWindow(contents: WebContents): void {
  const entry = panelWindowFor(contents)
  const window = entry && windows.get(keyOf(entry))?.window
  if (!entry || !window || window.isDestroyed()) return
  const main = appState.mainWindowRef
  const target = main && !main.isDestroyed() ? main.getContentBounds() : undefined
  const from = window.getBounds()
  const into = target
    ? seed({ x: target.x + target.width - 140, y: target.y + 120 }, from)
    : seed({ x: from.x + from.width / 2, y: from.y + from.height / 2 }, from)
  void glide(window, from, into, [1, 0]).then(() => {
    if (main && !main.isDestroyed()) {
      main.webContents.send('panelWindows:docked', entry)
      main.focus()
    }
    if (!window.isDestroyed()) window.close()
  })
}

export function closePanelWindows(): void {
  for (const { window } of [...windows.values()]) if (!window.isDestroyed()) window.close()
  windows.clear()
}
