import { createHash } from 'crypto'
import { BrowserWindow, screen } from 'electron'
import { appState } from '../ipc/state'
import type { ComputerWindowBounds } from './computerUseDriver'
import { escapeHtml, trustedLook, trustedLookCss, type TrustedLook } from './trustedLook'

const FOLLOW_MS = 400
// Room around the app's window for the glow to fade out in.
const GLOW_DIP = 32
const CURSOR_WINDOW_DIP = 120
// Where the arrow's tip sits in its window, with room for the ripple around it.
const CURSOR_TIP_DIP = 40
const CURSOR_GLIDE_MS = 480
const CURSOR_FRAME_MS = 16
const PILL_WIDTH_DIP = 380
const PILL_HEIGHT_DIP = 52
const PILL_MARGIN_DIP = 12

export interface ComputerHighlightTarget {
  appName: string
  /** Whether any of the app shows. A covered or minimized app must not draw over the user's work. */
  visible: () => Promise<boolean>
  /** Where the app's window is now, or null when there is nothing to outline. */
  bounds: () => Promise<ComputerWindowBounds | null>
}

/**
 * A glow and a label around a visible app; just the label, in a corner, for one that isn't. No script:
 * the page only ever shows what it was given.
 */
export function computerHighlightPage(
  appName: string,
  look: TrustedLook,
  mode: 'glow' | 'pill'
): string {
  const name = escapeHtml(appName)
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>SideKick is using ${name}</title>
<style>
${trustedLookCss(look)}
html, body { height: 100%; padding: 0; }
.glow {
  position: fixed; inset: ${GLOW_DIP}px; border-radius: 10px;
  border: 1.5px solid color-mix(in srgb, var(--accent) 85%, transparent);
  box-shadow:
    0 0 ${GLOW_DIP - 4}px 4px color-mix(in srgb, var(--accent) 60%, transparent),
    inset 0 0 40px 2px color-mix(in srgb, var(--accent) 34%, transparent);
  animation: breathe 2.6s ease-in-out infinite;
}
@keyframes breathe { 50% { opacity: 0.7; } }
.label {
  position: fixed;
  ${mode === 'glow' ? `top: ${GLOW_DIP + 10}px; left: 50%; transform: translateX(-50%);` : 'right: 10px; bottom: 10px;'}
  display: flex; gap: 8px; align-items: center;
  max-width: calc(100% - ${mode === 'glow' ? GLOW_DIP * 2 + 24 : 20}px); padding: 5px 13px;
  border: 1px solid var(--border); border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: 0 6px 20px var(--shadow);
  font-size: 12px; font-weight: 500; white-space: nowrap;
}
.dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.text { overflow: hidden; text-overflow: ellipsis; }
.stop { color: var(--text-2); }
</style>
</head>
<body>
${mode === 'glow' ? '<div class="glow"></div>' : ''}
<div class="label"><span class="dot"></span><span class="text">SideKick is using ${name} <span class="stop">· Esc to stop</span></span></div>
</body>
</html>`
}

const CURSOR_SCRIPT = `
window.ripple = () => {
  const ring = document.querySelector('.ring')
  ring.classList.remove('go')
  void ring.offsetWidth
  ring.classList.add('go')
}
`

/** The agent's own pointer: bigger than the driver's, and in SideKick's colour. */
export function computerCursorPage(look: TrustedLook): string {
  const hash = createHash('sha256').update(CURSOR_SCRIPT).digest('base64')
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>SideKick's pointer</title>
<style>
${trustedLookCss(look)}
html, body { height: 100%; padding: 0; }
.arrow { position: fixed; left: ${CURSOR_TIP_DIP}px; top: ${CURSOR_TIP_DIP}px; filter: drop-shadow(0 3px 7px var(--shadow)) drop-shadow(0 0 9px color-mix(in srgb, var(--accent) 55%, transparent)); }
.ring {
  position: fixed; left: ${CURSOR_TIP_DIP - 20}px; top: ${CURSOR_TIP_DIP - 20}px; width: 40px; height: 40px;
  border: 2.5px solid var(--accent); border-radius: 50%; opacity: 0;
}
.ring.go { animation: ripple 520ms ease-out; }
@keyframes ripple { from { opacity: 0.9; transform: scale(0.2); } to { opacity: 0; transform: scale(1.3); } }
</style>
</head>
<body>
<div class="ring"></div>
<svg class="arrow" width="38" height="46" viewBox="0 0 38 46" aria-hidden="true">
  <path d="M2 2 L2 37 L11.5 28.5 L18 43 L25 40 L18.5 25.5 L31 25.5 Z" fill="var(--accent)" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
</svg>
<script>${CURSOR_SCRIPT}</script>
</body>
</html>`
}

function overlayWindow(title: string, javascript: boolean): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    title,
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      javascript
    }
  })
  window.setIgnoreMouseEvents(true)
  window.setAlwaysOnTop(true, 'screen-saver')
  // A screenshot of the app is for the model to read, so these stay out of it.
  window.setContentProtection(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  return window
}

/**
 * Marks the app the agent is working in, following it, and draws the agent's pointer. Neither window
 * ever takes a click or focus, and both stay until the service hides them.
 */
export class ComputerUseHighlight {
  private window: BrowserWindow | null = null
  private target: ComputerHighlightTarget | null = null
  private following: ReturnType<typeof setTimeout> | null = null
  private page = ''
  private cursor: BrowserWindow | null = null
  private cursorAt: { x: number; y: number } | null = null
  private gliding: ReturnType<typeof setInterval> | null = null
  private center: { x: number; y: number } | null = null
  private mode: 'glow' | 'pill' = 'pill'

  show(target: ComputerHighlightTarget): void {
    const running = this.target !== null
    this.target = target
    void this.showPage(target)
    if (!running) void this.follow()
  }

  hide(): void {
    this.target = null
    this.page = ''
    if (this.following) clearTimeout(this.following)
    this.following = null
    if (this.gliding) clearInterval(this.gliding)
    this.gliding = null
    this.cursorAt = null
    this.center = null
    this.mode = 'pill'
    for (const window of [this.window, this.cursor]) {
      if (window && !window.isDestroyed()) window.destroy()
    }
    this.window = null
    this.cursor = null
  }

  /** Glides the pointer to a screen point, in physical pixels, and shows the click landing. */
  moveCursor(point: { x: number; y: number }): void {
    if (!this.target) return
    void this.glide(screen.screenToDipPoint(point))
  }

  private async glide(to: { x: number; y: number }): Promise<void> {
    if (!this.cursor || this.cursor.isDestroyed()) {
      const look = await trustedLook(appState.mainWindowRef)
      if (!this.target) return
      this.cursor = overlayWindow("SideKick's pointer", true)
      this.cursor.setBounds(this.cursorBounds(this.center ?? to))
      await this.cursor
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerCursorPage(look))}`)
        .catch(() => undefined)
      if (!this.target || !this.cursor || this.cursor.isDestroyed()) return
      this.cursorAt = this.center ?? to
      if (this.mode === 'glow') this.cursor.showInactive()
    }
    const cursor = this.cursor
    const from = this.cursorAt ?? to
    if (this.gliding) clearInterval(this.gliding)
    const started = Date.now()
    this.gliding = setInterval(() => {
      if (cursor.isDestroyed()) return
      const t = Math.min((Date.now() - started) / CURSOR_GLIDE_MS, 1)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const at = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased }
      this.cursorAt = at
      cursor.setBounds(this.cursorBounds(at))
      if (t < 1) return
      if (this.gliding) clearInterval(this.gliding)
      this.gliding = null
      void cursor.webContents.executeJavaScript('window.ripple()').catch(() => undefined)
    }, CURSOR_FRAME_MS)
  }

  private cursorBounds(at: { x: number; y: number }): Electron.Rectangle {
    return {
      x: Math.round(at.x - CURSOR_TIP_DIP),
      y: Math.round(at.y - CURSOR_TIP_DIP),
      width: CURSOR_WINDOW_DIP,
      height: CURSOR_WINDOW_DIP
    }
  }

  private async showPage(target: ComputerHighlightTarget): Promise<void> {
    const look = await trustedLook(appState.mainWindowRef)
    if (this.target !== target) return
    const page = computerHighlightPage(target.appName, look, this.mode)
    if (page === this.page) return
    this.page = page
    if (!this.window || this.window.isDestroyed()) {
      this.window = overlayWindow('SideKick is using an app', false)
      this.window.webContents.on('render-process-gone', () => this.hide())
    }
    await this.window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      .catch(() => undefined)
  }

  private async follow(): Promise<void> {
    const target = this.target
    if (!target) return
    const [bounds, visible] = await Promise.all([
      target.bounds().catch(() => null),
      target.visible().catch(() => false)
    ])
    // A new action can replace the target while its position was on the way.
    if (!this.target) return
    const mode = bounds && visible ? 'glow' : 'pill'
    if (mode !== this.mode) {
      this.mode = mode
      await this.showPage(this.target)
      if (!this.target) return
    }
    const window = this.window
    if (window && !window.isDestroyed()) {
      if (bounds && mode === 'glow') {
        const dip = screen.screenToDipRect(null, bounds)
        this.center = { x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 }
        window.setBounds({
          x: dip.x - GLOW_DIP,
          y: dip.y - GLOW_DIP,
          width: dip.width + GLOW_DIP * 2,
          height: dip.height + GLOW_DIP * 2
        })
      } else {
        const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        window.setBounds({
          x: workArea.x + workArea.width - PILL_WIDTH_DIP - PILL_MARGIN_DIP,
          y: workArea.y + workArea.height - PILL_HEIGHT_DIP - PILL_MARGIN_DIP,
          width: PILL_WIDTH_DIP,
          height: PILL_HEIGHT_DIP
        })
      }
      if (!window.isVisible()) window.showInactive()
    }
    if (this.cursor && !this.cursor.isDestroyed()) {
      if (mode === 'pill' && this.cursor.isVisible()) this.cursor.hide()
      else if (mode === 'glow' && !this.cursor.isVisible()) this.cursor.showInactive()
    }
    this.following = setTimeout(() => void this.follow(), FOLLOW_MS)
  }
}
