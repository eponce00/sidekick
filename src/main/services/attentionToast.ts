import { createHash } from 'crypto'
import { BrowserWindow, screen } from 'electron'
import { escapeHtml, trustedLookCss, type TrustedLook } from './trustedLook'

const TOAST_WIDTH = 380
const MARGIN = 16
const SCHEME = 'sidekick-notice:'

export interface AttentionToastRequest {
  title: string
  message: string
  warning: boolean
  look: TrustedLook
  /** Clicking the notice: bring SideKick up. */
  onOpen: () => void
}

/** The notice's page: SideKick's look, and a script that reports a click by navigating. */
export function attentionToastPage({
  title,
  message,
  warning,
  look
}: Omit<AttentionToastRequest, 'onOpen'>): string {
  const script = `
document.querySelector('.notice').addEventListener('click', () => { location.href = '${SCHEME}open' })
document.querySelector('.close').addEventListener('click', (event) => {
  event.stopPropagation()
  location.href = '${SCHEME}close'
})
requestAnimationFrame(() => {
  location.href = '${SCHEME}size/' + Math.ceil(document.querySelector('.notice').getBoundingClientRect().height)
})
`
  const scriptHash = createHash('sha256').update(script).digest('base64')
  const icon = warning
    ? '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/>'
    : '<circle cx="12" cy="12" r="9"/><path d="M12 8v.5"/><path d="M12 11v5"/>'
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'">
<title>${escapeHtml(title)}</title>
<style>
${trustedLookCss(look)}
.notice {
  position: relative;
  display: flex; gap: 12px; align-items: flex-start;
  padding: 14px 40px 14px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 12px 32px var(--shadow);
  cursor: pointer;
  animation: arrive 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.notice:hover { background: var(--surface-2); }
@keyframes arrive { from { opacity: 0; transform: translateY(12px); } }
.icon {
  display: grid; flex-shrink: 0; width: 30px; height: 30px; place-items: center;
  border-radius: 8px; background: var(--surface-3); color: ${warning ? 'var(--warning)' : 'var(--accent)'};
}
.text { min-width: 0; }
.title { margin: 1px 0 2px; font-size: 13px; font-weight: 600; }
.message { margin: 0; color: var(--text-2); font-size: 13px; overflow-wrap: anywhere; }
.action { margin-top: 8px; color: var(--accent); font-size: 12px; font-weight: 600; }
.close {
  position: absolute; top: 8px; right: 8px; width: 24px; height: 24px;
  border: 0; border-radius: 6px; background: transparent; color: var(--text-2); cursor: pointer;
  font: inherit; font-size: 15px; line-height: 1;
}
.close:hover { background: var(--surface-3); color: var(--text); }
</style>
</head>
<body>
<div class="notice" role="alert">
  <div class="icon" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
  <div class="text">
    <p class="title">${escapeHtml(title)}</p>
    <p class="message">${escapeHtml(message)}</p>
    <div class="action">Open SideKick to answer</div>
  </div>
  <button type="button" class="close" aria-label="Dismiss">&#x2715;</button>
</div>
<script>${script}</script>
</body>
</html>`
}

/**
 * A notice in SideKick's own look, in the corner of the screen the user is on, for when SideKick
 * is not in front and something needs them. It never takes focus from what they are doing, and
 * clicking it brings SideKick up. Returns a function that takes it away again.
 */
export function showAttentionToast(request: AttentionToastRequest): () => void {
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
    width: TOAST_WIDTH,
    height: 140,
    title: request.title,
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
  let reported = false
  const close = (): void => {
    if (!window.isDestroyed()) window.destroy()
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (!url.startsWith(SCHEME)) return
    const [kind, value] = url.slice(SCHEME.length).split('/')
    if (kind === 'size') {
      reported = true
      const height = Math.min(Math.max(Number(value) || 100, 60) + 20, 260)
      const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      window.setBounds({
        x: Math.round(workArea.x + workArea.width - TOAST_WIDTH - MARGIN),
        y: Math.round(workArea.y + workArea.height - height - MARGIN),
        width: TOAST_WIDTH,
        height
      })
      if (!window.isVisible()) window.showInactive()
    } else if (kind === 'open') {
      close()
      request.onOpen()
    } else if (kind === 'close') {
      close()
    }
  })
  window.webContents.on('render-process-gone', close)
  // The page reports its size by a navigation that is refused; when that comes before the load
  // has finished, the load counts as failed although the page is up. Only a page that never
  // reported in has failed.
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(attentionToastPage(request))}`)
    .catch(() => {
      if (!reported) close()
    })
  return close
}
