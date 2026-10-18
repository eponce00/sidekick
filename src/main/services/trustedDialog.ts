import { createHash } from 'crypto'
import {
  BrowserWindow,
  dialog,
  nativeTheme,
  Notification,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import { appState } from '../ipc/state'
import { isBrowserParkingWindow } from './browserViewHost'
import { whileWaitingForUser } from './toolExecutionPipeline'

const DIALOG_WIDTH = 460
const RESPONSE_SCHEME = 'sidekick-dialog:'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function parentTheme(parent: BrowserWindow): Promise<'light' | 'dark'> {
  // Only the colours depend on this; anything unexpected falls back to the system theme.
  const fallback = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  try {
    const theme = await Promise.race([
      parent.webContents.executeJavaScript('document.documentElement.dataset.theme || ""', false),
      new Promise((resolve) => setTimeout(() => resolve(''), 150))
    ])
    return theme === 'light' || theme === 'dark' ? theme : fallback
  } catch {
    return fallback
  }
}

/** The dialog's page: SideKick's look, and a script that reports the choice by navigating. */
export function trustedDialogPage(options: MessageBoxOptions, theme: 'light' | 'dark'): string {
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  const cancelId = options.cancelId ?? 0
  const defaultId = options.defaultId ?? buttons.length - 1
  const warning = options.type === 'warning' || options.type === 'error'
  // The main action is the default unless the default is Cancel; then it is the last other button.
  const others = buttons.map((_, index) => index).filter((index) => index !== cancelId)
  const primaryId = defaultId !== cancelId ? defaultId : (others.at(-1) ?? -1)
  // Cancel sits on the left, as in SideKick's own dialogs.
  const order = buttons.length > 1 ? [cancelId, ...others] : [0]
  const buttonHtml = order
    .map((index) => {
      const label = buttons[index]
      return `<button type="button" data-index="${index}" class="${
        index === primaryId ? 'primary' : ''
      }"${index === defaultId ? ' autofocus' : ''}>${escapeHtml(label)}</button>`
    })
    .join('')
  const checkbox = options.checkboxLabel
    ? `<label class="check"><input type="checkbox" id="check"${
        options.checkboxChecked ? ' checked' : ''
      }> ${escapeHtml(options.checkboxLabel)}</label>`
    : ''
  const script = `
const respond = (index) => {
  const box = document.getElementById('check')
  location.href = '${RESPONSE_SCHEME}respond/' + index + '/' + (box && box.checked ? 1 : 0)
}
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => respond(button.dataset.index))
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') respond(${cancelId})
})
const report = () => {
  location.href = '${RESPONSE_SCHEME}size/' + Math.ceil(document.querySelector('.card').getBoundingClientRect().height)
}
requestAnimationFrame(report)
`
  const scriptHash = createHash('sha256').update(script).digest('base64')
  const dark = theme === 'dark'
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'">
<title>${escapeHtml(options.title || 'SideKick')}</title>
<style>
:root {
  --surface: ${dark ? '#171717' : '#ffffff'};
  --surface-2: ${dark ? '#1d1d1d' : '#eeeeee'};
  --surface-3: ${dark ? '#252525' : '#e3e3e3'};
  --border: ${dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.12)'};
  --text: ${dark ? '#ececec' : '#161616'};
  --text-2: ${dark ? '#a9a9a9' : '#4c4c4c'};
  --accent: ${dark ? '#b4d36b' : '#4a6e14'};
  --on-accent: ${dark ? '#111111' : '#ffffff'};
  --warning: ${dark ? '#e9a05f' : '#a23d0e'};
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  padding: 10px;
  color: var(--text);
  font: 14px/1.5 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-user-select: none;
  user-select: none;
}
.card {
  padding: 20px 20px 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 12px 32px rgba(0, 0, 0, ${dark ? '0.45' : '0.18'});
  animation: rise 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes rise { from { opacity: 0; transform: translateY(6px) scale(0.985); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
.head { display: flex; gap: 12px; align-items: flex-start; }
.icon {
  display: grid; flex-shrink: 0; width: 32px; height: 32px; place-items: center;
  border-radius: 9px; background: var(--surface-2); color: ${warning ? 'var(--warning)' : 'var(--accent)'};
}
h1 { margin: 4px 0 0; font-size: 15px; font-weight: 600; }
.detail {
  max-height: 320px; margin: 10px 0 0 44px; overflow-y: auto;
  color: var(--text-2); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere;
  -webkit-user-select: text; user-select: text;
}
.check { display: flex; gap: 8px; align-items: center; margin: 12px 0 0 44px; color: var(--text-2); font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
button {
  height: 32px; padding: 0 14px; border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); background: var(--surface-2); font: inherit; font-size: 13px; cursor: pointer;
}
button:hover { background: var(--surface-3); }
button.primary { border-color: transparent; color: var(--on-accent); background: var(--accent); font-weight: 600; }
button.primary:hover { filter: brightness(1.08); }
button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent); }
</style>
</head>
<body>
<div class="card" role="${warning ? 'alertdialog' : 'dialog'}" aria-labelledby="message">
  <div class="head">
    <div class="icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
        warning
          ? '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/>'
          : '<circle cx="12" cy="12" r="9"/><path d="M12 8v.5"/><path d="M12 11v5"/>'
      }</svg>
    </div>
    <h1 id="message">${escapeHtml(options.message)}</h1>
  </div>
  ${options.detail ? `<div class="detail">${escapeHtml(options.detail)}</div>` : ''}
  ${checkbox}
  <div class="actions">${buttonHtml}</div>
</div>
<script>${script}</script>
</body>
</html>`
}

export interface TrustedDialogRequest {
  /** Stops asking, answering Cancel, when whatever is waiting gives up, such as a stopped run. */
  signal?: AbortSignal
  /**
   * Brings the window up to ask, for a question the user has just set off themselves, such as
   * quitting from the tray. Otherwise a question waits, with a notification, until they bring
   * SideKick back.
   */
  reveal?: boolean
}

function onScreen(window: BrowserWindow): boolean {
  return window.isVisible() && !window.isMinimized()
}

/** Resolves true once the window is up where the user can answer, or false if it closes or the wait ends. */
function untilShown(owner: BrowserWindow, signal: AbortSignal | undefined): Promise<boolean> {
  if (onScreen(owner)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (shown: boolean): void => {
      owner.off('show', check)
      owner.off('restore', check)
      owner.off('closed', closed)
      signal?.removeEventListener('abort', aborted)
      resolve(shown)
    }
    const check = (): void => {
      if (onScreen(owner)) done(true)
    }
    const closed = (): void => done(false)
    const aborted = (): void => done(false)
    owner.on('show', check)
    owner.on('restore', check)
    owner.once('closed', closed)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * The window a question belongs over. A browser page's window is parked off screen, so a dialog
 * centred on it would be open where nobody can see it; the app's own window stands in for it.
 */
function dialogOwner(parent: BrowserWindow | null): BrowserWindow | null {
  if (!parent || parent.isDestroyed()) return null
  if (!isBrowserParkingWindow(parent)) return parent
  const main = appState.mainWindowRef
  return main && !main.isDestroyed() ? main : null
}

/**
 * Makes sure a question is noticed when SideKick is not in front: the taskbar entry flashes and a
 * notification says what is being asked; clicking it brings the window up. Returns a function
 * that takes both back once the question is answered.
 */
function callAttention(owner: BrowserWindow | null, options: MessageBoxOptions): () => void {
  if (!owner || (owner.isFocused() && onScreen(owner))) return () => undefined
  owner.flashFrame(true)
  let notice: Notification | undefined
  if (Notification.isSupported()) {
    notice = new Notification({
      title: options.title || 'SideKick needs your answer',
      body: options.message,
      silent: false
    })
    notice.on('click', () => {
      if (owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
    })
    notice.show()
  }
  return () => {
    if (!owner.isDestroyed()) owner.flashFrame(false)
    notice?.close()
  }
}

/**
 * Asks the user something the main process must hear from them directly, in SideKick's style.
 * Like a system dialog, it is its own window that only the main process controls: the app's
 * window cannot read, click or cover it, so it can approve security-sensitive changes. When
 * SideKick is not in front it calls for attention. With its window minimized or in the tray, the
 * question waits until the user brings it back, or brings it up at once when they set it off
 * (`reveal`). Only with no window at all does it ask with the system dialog. A tool waiting on
 * the answer does not spend its time limit meanwhile.
 */
export function showTrustedDialog(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
  request: TrustedDialogRequest = {}
): Promise<MessageBoxReturnValue> {
  return whileWaitingForUser(() => askTrusted(parent, options, request))
}

async function askTrusted(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
  { signal, reveal }: TrustedDialogRequest
): Promise<MessageBoxReturnValue> {
  const buttons = options.buttons?.length ? options.buttons : ['OK']
  const cancelId = options.cancelId ?? 0
  const cancelled: MessageBoxReturnValue = { response: cancelId, checkboxChecked: false }
  if (signal?.aborted) return cancelled
  const owner = dialogOwner(parent)
  const release = callAttention(owner, options)
  try {
    if (!owner) return await dialog.showMessageBox(signal ? { ...options, signal } : options)
    if (reveal && !onScreen(owner)) {
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
    }
    if (!(await untilShown(owner, signal)) || owner.isDestroyed()) return cancelled
    return await presentTrusted(owner, options, buttons, cancelId, signal)
  } finally {
    release()
  }
}

async function presentTrusted(
  parent: BrowserWindow,
  options: MessageBoxOptions,
  buttons: string[],
  cancelId: number,
  signal: AbortSignal | undefined
): Promise<MessageBoxReturnValue> {
  const theme = await parentTheme(parent)
  const window = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    width: DIALOG_WIDTH,
    height: 220,
    title: options.title || 'SideKick',
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      javascript: true
    }
  })

  return new Promise<MessageBoxReturnValue>((resolve) => {
    let settled = false
    const finish = (response: number, checkboxChecked = false): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abandon)
      resolve({ response, checkboxChecked })
      if (!window.isDestroyed()) window.destroy()
    }
    // Whatever was waiting gave up, so the question no longer stands.
    const abandon = (): void => finish(cancelId, false)
    signal?.addEventListener('abort', abandon, { once: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (!url.startsWith(RESPONSE_SCHEME)) return
      const [kind, first, second] = url.slice(RESPONSE_SCHEME.length).split('/')
      if (kind === 'size') {
        // Fit the window to the card, centred over the app a little above the middle.
        const height = Math.min(Math.max(Number(first) || 200, 120) + 20, 640)
        const bounds = parent.getBounds()
        window.setBounds({
          x: Math.round(bounds.x + (bounds.width - DIALOG_WIDTH) / 2),
          y: Math.round(bounds.y + Math.max(40, (bounds.height - height) / 3)),
          width: DIALOG_WIDTH,
          height
        })
        if (!window.isVisible()) window.show()
        return
      }
      const index = Number(first)
      if (kind === 'respond' && Number.isInteger(index) && index >= 0 && index < buttons.length)
        finish(index, second === '1')
    })
    // Closing it any other way, or a crash, is the same as Cancel.
    window.on('closed', () => finish(cancelId, false))
    window.webContents.on('render-process-gone', () => finish(cancelId, false))
    void window
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(trustedDialogPage(options, theme))}`
      )
      .catch(() => finish(cancelId, false))
  })
}
