import { BrowserWindow, screen } from 'electron'
import { appState } from '../ipc/state'
import type { ComputerWindowBounds } from './computerUseDriver'
import { escapeHtml, trustedLook, trustedLookCss, type TrustedLook } from './trustedLook'

const FOLLOW_MS = 400

export interface ComputerHighlightTarget {
  appName: string
  /** The agent may use the real mouse and keyboard in this app. */
  takeover: boolean
  /** Where the app's window is now, or null when there is nothing to outline. */
  bounds: () => Promise<ComputerWindowBounds | null>
}

/** A border and a label, and no script: the page only ever shows what it was given. */
export function computerHighlightPage(
  target: Pick<ComputerHighlightTarget, 'appName' | 'takeover'>,
  look: TrustedLook
): string {
  const name = escapeHtml(target.appName)
  const label = target.takeover
    ? `SideKick may use your mouse and keyboard in ${name} · Esc to stop`
    : `SideKick is using ${name} · Esc to stop`
  const color = target.takeover ? 'var(--warning)' : 'var(--accent)'
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>SideKick is using ${name}</title>
<style>
${trustedLookCss(look)}
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
.frame { position: fixed; inset: 0; border: 3px solid ${color}; border-radius: 8px; }
.label {
  position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
  box-sizing: border-box; max-width: calc(100% - 24px); padding: 4px 12px;
  border-radius: 999px; background: ${color}; color: var(--surface);
  font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
</style>
</head>
<body>
<div class="frame"></div>
<div class="label">${label}</div>
</body>
</html>`
}

/** Outlines the app the agent is working in, following it, and never takes a click or focus. */
export class ComputerUseHighlight {
  private window: BrowserWindow | null = null
  private target: ComputerHighlightTarget | null = null
  private following: ReturnType<typeof setTimeout> | null = null
  private page = ''

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
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  private create(): BrowserWindow {
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
      title: 'SideKick is using an app',
      backgroundColor: '#00000000',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        javascript: false
      }
    })
    window.setIgnoreMouseEvents(true)
    window.setAlwaysOnTop(true, 'screen-saver')
    // A screenshot of the app is for the model to read, so this stays out of it.
    window.setContentProtection(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => this.hide())
    return window
  }

  private async showPage(target: ComputerHighlightTarget): Promise<void> {
    const look = await trustedLook(appState.mainWindowRef)
    if (this.target !== target) return
    const page = computerHighlightPage(target, look)
    if (page === this.page) return
    this.page = page
    if (!this.window || this.window.isDestroyed()) this.window = this.create()
    await this.window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      .catch(() => undefined)
  }

  private async follow(): Promise<void> {
    const target = this.target
    if (!target) return
    const bounds = await target.bounds().catch(() => null)
    // A new action can replace the target while its position was on the way.
    if (this.target) {
      const window = this.window
      if (window && !window.isDestroyed()) {
        if (bounds) {
          window.setBounds(screen.screenToDipRect(null, bounds))
          if (!window.isVisible()) window.showInactive()
        } else if (window.isVisible()) {
          window.hide()
        }
      }
      this.following = setTimeout(() => void this.follow(), FOLLOW_MS)
    }
  }
}
