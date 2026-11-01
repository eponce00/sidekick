import { createHash } from 'crypto'
import { BrowserWindow, nativeImage, screen } from 'electron'
import { appState } from '../ipc/state'
import type { ComputerWindowBounds } from './computerUseDriver'
import { escapeHtml, trustedLook, trustedLookCss, type TrustedLook } from './trustedLook'

const FOLLOW_MS = 400
// Room around the app's window for the glow to fade out in.
const GLOW_DIP = 32
const CURSOR_WINDOW_DIP = 76
// Where the arrow's tip sits in its window, with room for the ripple around it.
const CURSOR_TIP_DIP = 26
const CURSOR_GLIDE_MS = 300
const CURSOR_FRAME_MS = 16
const PICTURE_WIDTH_DIP = 340
const PICTURE_MIN_WIDTH_DIP = 220
const PICTURE_LABEL_DIP = 36
// Sharp enough for a window the user has made a good deal bigger.
const PICTURE_SOURCE_WIDTH = 960
const PICTURE_MARGIN_DIP = 12
const PICTURE_BOUNDS_KEY = 'computerPictureBounds'

export interface ComputerHighlightTarget {
  appName: string
  /** Whether any of the app shows. A covered or minimized app must not draw over the user's work. */
  visible: () => Promise<boolean>
  /** Where the app's window is now, or null when there is nothing to outline. */
  bounds: () => Promise<ComputerWindowBounds | null>
}

/** A glow and a label around a visible app. No script: the page only ever shows what it was given. */
export function computerHighlightPage(appName: string, look: TrustedLook): string {
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
  position: fixed; top: ${GLOW_DIP + 10}px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 8px; align-items: center;
  max-width: calc(100% - ${GLOW_DIP * 2 + 24}px); padding: 5px 13px;
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
<div class="glow"></div>
<div class="label"><span class="dot"></span><span class="text">SideKick is using ${name} <span class="stop">· Esc to stop</span></span></div>
</body>
</html>`
}

const PICTURE_SCHEME = 'sidekick-picture:'
const PICTURE_SCRIPT = `
const picture = document.querySelector('img')
window.setPicture = (source) => {
  picture.src = source
  picture.hidden = false
}
document.querySelector('button').addEventListener('click', () => { location.href = '${PICTURE_SCHEME}close' })
`

/**
 * What the agent last saw, for when the app itself can't be seen. The user's to move, resize or close,
 * and only ever shows pictures it is handed.
 */
export function computerPicturePage(appName: string, look: TrustedLook): string {
  const hash = createHash('sha256').update(PICTURE_SCRIPT).digest('base64')
  const name = escapeHtml(appName)
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>SideKick is using ${name}</title>
<style>
${trustedLookCss(look)}
html, body { height: 100%; padding: 0; overflow: hidden; }
body { display: flex; flex-direction: column; background: var(--surface); user-select: none; -webkit-app-region: drag; }
img { flex: 1; min-height: 0; width: 100%; object-fit: contain; background: var(--surface-2); pointer-events: none; }
img[hidden] { display: none; }
.label {
  flex-shrink: 0; display: flex; gap: 8px; align-items: center;
  height: ${PICTURE_LABEL_DIP}px; padding: 0 6px 0 12px; box-sizing: border-box;
  font-size: 12px; font-weight: 500; white-space: nowrap;
}
.dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.stop { color: var(--text-2); }
button {
  flex-shrink: 0; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  color: var(--text-2); background: transparent; font: inherit; font-size: 15px; line-height: 1;
  cursor: pointer; -webkit-app-region: no-drag;
}
button:hover { color: var(--text); background: var(--surface-3); }
</style>
</head>
<body>
<img alt="" hidden>
<div class="label"><span class="dot"></span><span class="text">SideKick is using ${name} <span class="stop">· Esc to stop</span></span><button type="button" title="Hide. The agent keeps working." aria-label="Hide. The agent keeps working.">×</button></div>
<script>${PICTURE_SCRIPT}</script>
</body>
</html>`
}

const CURSOR_SCRIPT = `
window.ripple = () => {
  for (const part of [document.querySelector('.ring'), document.querySelector('.arrow')]) {
    part.classList.remove('go')
    void part.getBoundingClientRect()
    part.classList.add('go')
  }
}
`

/** The agent's own pointer, in SideKick's colour: the one the user sees it working with. */
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
.arrow {
  position: fixed; left: ${CURSOR_TIP_DIP - 3}px; top: ${CURSOR_TIP_DIP - 2}px; transform-origin: 3px 2px;
  filter: drop-shadow(0 2px 4px var(--shadow)) drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 45%, transparent));
}
.arrow.go { animation: squish 240ms ease-out; }
@keyframes squish { 40% { transform: scale(0.82); } }
.ring {
  position: fixed; left: ${CURSOR_TIP_DIP - 16}px; top: ${CURSOR_TIP_DIP - 16}px; width: 32px; height: 32px;
  border: 2px solid var(--accent); border-radius: 50%; opacity: 0;
}
.ring.go { animation: ripple 460ms ease-out; }
@keyframes ripple { from { opacity: 0.9; transform: scale(0.2); } to { opacity: 0; transform: scale(1.3); } }
</style>
</head>
<body>
<div class="ring"></div>
<svg class="arrow" width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
  <path d="M3 4.4C3 2.6 5 1.6 6.4 2.7l15.5 12.4c1.5 1.2.7 3.6-1.2 3.7l-6.1.3c-.8 0-1.5.5-1.9 1.2l-3.1 5.9c-.9 1.7-3.5 1.3-3.8-.6z" fill="var(--accent)" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
</svg>
<script>${CURSOR_SCRIPT}</script>
</body>
</html>`
}

const TEACH_SCHEME = 'sidekick-teach:'
const TEACH_WIDTH_DIP = 340
const TEACH_GAP_DIP = 28
const TEACH_SCRIPT = `
for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => { location.href = '${TEACH_SCHEME}' + button.dataset.answer })
}
const report = () => { location.href = '${TEACH_SCHEME}size/' + Math.ceil(document.querySelector('.card').getBoundingClientRect().height) }
report()
`

/**
 * One step of a walkthrough. The words are the model's, so they are only ever text here, and the card
 * says whose they are and what Next will do, so it can't pass for SideKick asking for an approval.
 */
export function computerTeachPage(
  step: { appName: string; text: string; nextDoes: number },
  look: TrustedLook
): string {
  const hash = createHash('sha256').update(TEACH_SCRIPT).digest('base64')
  const next = step.nextDoes
    ? `Next lets the agent do ${step.nextDoes === 1 ? 'this step' : `these ${step.nextDoes} steps`} in ${escapeHtml(step.appName)}.`
    : ''
  return `<!doctype html>
<html data-theme="${look.theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>SideKick is showing you ${escapeHtml(step.appName)}</title>
<style>
${trustedLookCss(look)}
html, body { padding: 0; background: transparent; }
.card {
  box-sizing: border-box; width: ${TEACH_WIDTH_DIP}px;
  margin: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface); box-shadow: 0 8px 24px var(--shadow); font-size: 13px; line-height: 1.45;
}
.who { display: flex; gap: 7px; align-items: center; margin-bottom: 6px; color: var(--text-2); font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.next { margin-top: 8px; color: var(--text-2); font-size: 12px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
button {
  height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); background: var(--surface-2); font: inherit; font-size: 12px; cursor: pointer;
}
button:hover { background: var(--surface-3); }
button.primary { border-color: transparent; color: var(--on-accent); background: var(--accent); font-weight: 600; }
button.primary:hover { filter: brightness(1.08); }
</style>
</head>
<body>
<div class="card">
  <div class="who"><span class="dot"></span>The agent, showing you ${escapeHtml(step.appName)}</div>
  <div class="text">${escapeHtml(step.text)}</div>
  ${next ? `<div class="next">${next}</div>` : ''}
  <div class="actions">
    <button data-answer="exit">Exit</button>
    <button class="primary" data-answer="next">Next</button>
  </div>
</div>
<script>${TEACH_SCRIPT}</script>
</body>
</html>`
}

function overlayWindow(
  title: string,
  javascript: boolean,
  options: Electron.BrowserWindowConstructorOptions = {}
): BrowserWindow {
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
    ...options,
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

/** Where the user last left the picture, as long as that is still somewhere on a screen. */
function savedPictureBounds(): Electron.Rectangle | null {
  const saved = appState.store?.get(PICTURE_BOUNDS_KEY) as Electron.Rectangle | undefined
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null
  const { workArea: area } = screen.getDisplayMatching(saved)
  const width = Math.min(saved.width, area.width)
  const height = Math.min(saved.height, area.height)
  return {
    x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
    width,
    height
  }
}

/** The corner of the screen the user is on, sized for a picture of this shape, or just the label. */
function pictureBounds(aspect: number): Electron.Rectangle {
  const { workArea: area } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const height = Math.round(PICTURE_WIDTH_DIP * aspect) + PICTURE_LABEL_DIP
  return {
    x: area.x + area.width - PICTURE_WIDTH_DIP - PICTURE_MARGIN_DIP,
    y: area.y + area.height - height - PICTURE_MARGIN_DIP,
    width: PICTURE_WIDTH_DIP,
    height
  }
}

/**
 * Marks the app the agent is working in, following it, and draws the agent's pointer. Neither of those
 * ever takes a click or focus. Nor does the picture take focus, though it is the user's to move, resize
 * and close. All stay until the service hides them.
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
  private picture: BrowserWindow | null = null
  private pictureName = ''
  private pictureOpening: Promise<void> | null = null
  /** Waiting to be shown, as data for an image. */
  private pictureSource = ''
  private pictureAspect = 0
  private pictureSized = false
  /** Closed by the user, which lasts until the reply ends. */
  private pictureClosed = false
  private endTeachStep: ((answer: 'next' | 'exit') => void) | null = null

  /**
   * A walkthrough step beside what it is about, until the user presses Next or Exit. The only overlay
   * that takes a click, and it never takes focus, so the app stays ready for what the user does in it.
   */
  async showTeachStep(
    step: {
      appName: string
      text: string
      nextDoes: number
      anchor: { x: number; y: number } | null
    },
    signal: AbortSignal
  ): Promise<'next' | 'exit'> {
    this.hideTeachStep()
    if (signal.aborted) return 'exit'
    const look = await trustedLook(appState.mainWindowRef)
    const anchor = step.anchor ? screen.screenToDipPoint(step.anchor) : null
    const window = overlayWindow('SideKick is showing you an app', true)
    window.setIgnoreMouseEvents(false)
    return new Promise((resolve) => {
      const finish = (answer: 'next' | 'exit'): void => {
        if (this.endTeachStep !== finish) return
        this.endTeachStep = null
        signal.removeEventListener('abort', abort)
        if (!window.isDestroyed()) window.destroy()
        resolve(answer)
      }
      const abort = (): void => finish('exit')
      this.endTeachStep = finish
      signal.addEventListener('abort', abort, { once: true })
      window.on('closed', abort)
      window.webContents.on('render-process-gone', abort)
      window.webContents.on('will-navigate', (_event, url) => {
        if (!url.startsWith(TEACH_SCHEME)) return
        const [kind, height] = url.slice(TEACH_SCHEME.length).split('/')
        if (kind === 'next' || kind === 'exit') return finish(kind)
        if (kind !== 'size') return
        window.setBounds(this.teachBounds(anchor, Math.max(Number(height) || 120, 80) + 20))
        if (!window.isVisible()) window.showInactive()
      })
      void window
        .loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(computerTeachPage(step, look))}`
        )
        // Reporting its size is a refused navigation, which can count as a failed load. That is fine.
        .catch(() => undefined)
    })
  }

  hideTeachStep(): void {
    this.endTeachStep?.('exit')
  }

  /** Beside the point, and on the side of it with room. With no point, low in the middle of the screen. */
  private teachBounds(anchor: { x: number; y: number } | null, height: number): Electron.Rectangle {
    const width = TEACH_WIDTH_DIP + 20
    const { workArea: area } = screen.getDisplayNearestPoint(
      anchor ?? screen.getCursorScreenPoint()
    )
    const clamp = (at: number, size: number, from: number, room: number): number =>
      Math.round(Math.min(Math.max(at, from), from + room - size))
    if (!anchor) {
      return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: area.y + area.height - height - PICTURE_MARGIN_DIP,
        width,
        height
      }
    }
    const fitsBelow = anchor.y + TEACH_GAP_DIP + height <= area.y + area.height
    return {
      x: clamp(anchor.x + TEACH_GAP_DIP, width, area.x, area.width),
      y: clamp(
        fitsBelow ? anchor.y + TEACH_GAP_DIP : anchor.y - TEACH_GAP_DIP - height,
        height,
        area.y,
        area.height
      ),
      width,
      height
    }
  }

  show(target: ComputerHighlightTarget): void {
    const running = this.target !== null
    this.target = target
    if (this.mode === 'glow') void this.showGlow(target)
    if (!running) void this.follow()
  }

  /** The reply is over, so the next one shows its picture again, however this one was left. */
  replyEnded(): void {
    this.pictureClosed = false
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
    this.pictureSource = ''
    this.pictureAspect = 0
    this.pictureSized = false
    for (const window of [this.window, this.cursor, this.picture]) {
      if (window && !window.isDestroyed()) window.destroy()
    }
    this.window = null
    this.cursor = null
    this.picture = null
  }

  /** The agent's latest look, shrunk, for the picture window when the app itself can't be seen. */
  showPreview(image: { data: string }): void {
    const whole = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
    if (whole.isEmpty()) return
    const small = whole.resize({
      width: Math.min(whole.getSize().width, PICTURE_SOURCE_WIDTH),
      quality: 'good'
    })
    const size = small.getSize()
    this.pictureAspect = size.height / size.width
    this.pictureSource = `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`
    this.fillPicture()
  }

  /** Hands the waiting picture over, and makes room the first time, unless the user has picked a size. */
  private fillPicture(): void {
    const window = this.picture
    if (!window || window.isDestroyed() || this.pictureOpening || !this.pictureSource) return
    const source = this.pictureSource
    this.pictureSource = ''
    void window.webContents
      .executeJavaScript(`window.setPicture(${JSON.stringify(source)})`)
      .catch(() => undefined)
    if (this.pictureSized) return
    this.pictureSized = true
    if (!savedPictureBounds()) window.setBounds(pictureBounds(this.pictureAspect))
  }

  /** Shows it where the user last left it, unless they closed it or are in SideKick and can see for themselves. */
  private async syncPicture(target: ComputerHighlightTarget): Promise<void> {
    const wanted =
      this.mode === 'pill' && !this.pictureClosed && BrowserWindow.getFocusedWindow() === null
    if (!wanted) {
      if (this.picture && !this.picture.isDestroyed() && this.picture.isVisible()) {
        this.picture.hide()
      }
      return
    }
    if (this.pictureName !== target.appName && this.picture && !this.picture.isDestroyed()) {
      this.picture.destroy()
      this.picture = null
    }
    if (!this.picture || this.picture.isDestroyed()) {
      this.pictureOpening = this.openPicture(target.appName).finally(() => {
        this.pictureOpening = null
      })
    }
    await this.pictureOpening
    if (!this.target || this.pictureClosed) return
    if (this.picture && !this.picture.isDestroyed() && !this.picture.isVisible()) {
      this.picture.showInactive()
    }
    this.fillPicture()
  }

  private async openPicture(appName: string): Promise<void> {
    const look = await trustedLook(appState.mainWindowRef)
    if (!this.target) return
    const window = overlayWindow(`SideKick is using ${appName}`, true, {
      // Windows only gives a window edges to resize by if it isn't transparent.
      transparent: false,
      resizable: true,
      movable: true,
      hasShadow: true,
      minWidth: PICTURE_MIN_WIDTH_DIP,
      minHeight: PICTURE_LABEL_DIP,
      backgroundColor: look.theme === 'dark' ? '#171717' : '#ffffff',
      ...(savedPictureBounds() ?? pictureBounds(this.pictureAspect))
    })
    window.setIgnoreMouseEvents(false)
    this.picture = window
    this.pictureName = appName
    this.pictureSized = this.pictureAspect > 0
    const remember = (): void => {
      if (!window.isDestroyed()) appState.store?.set(PICTURE_BOUNDS_KEY, window.getBounds())
    }
    // Both only ever come from the user moving it, not from SideKick placing it.
    window.on('moved', remember)
    window.on('resized', remember)
    window.webContents.on('will-navigate', (_event, url) => {
      if (url !== `${PICTURE_SCHEME}close`) return
      this.pictureClosed = true
      if (!window.isDestroyed()) window.hide()
    })
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy()
    })
    await window
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(computerPicturePage(appName, look))}`
      )
      .catch(() => undefined)
  }

  /**
   * Glides the pointer to a screen point, in physical pixels, and shows the click landing. Resolves
   * when it arrives, so a click can wait for it rather than happen first. No pointer shows while the
   * app can't be seen, so nothing moves over whatever the user has in front.
   */
  async moveCursor(point: { x: number; y: number }): Promise<void> {
    if (!this.target) return
    // Real input may have just brought the app forward, ahead of the next check.
    if (this.mode !== 'glow') await this.follow()
    if (!this.target) return
    if (this.mode !== 'glow') {
      this.cursorAt = screen.screenToDipPoint(point)
      return
    }
    await this.glide(screen.screenToDipPoint(point))
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
    if (!cursor.isVisible()) cursor.showInactive()
    const from = this.cursorAt ?? to
    if (this.gliding) clearInterval(this.gliding)
    const started = Date.now()
    await new Promise<void>((arrive) => {
      const finish = (): void => {
        if (this.gliding) clearInterval(this.gliding)
        this.gliding = null
        arrive()
      }
      this.gliding = setInterval(() => {
        if (cursor.isDestroyed()) return finish()
        const t = Math.min((Date.now() - started) / CURSOR_GLIDE_MS, 1)
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        const at = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased }
        this.cursorAt = at
        cursor.setBounds(this.cursorBounds(at))
        if (t < 1) return
        void cursor.webContents.executeJavaScript('window.ripple()').catch(() => undefined)
        finish()
      }, CURSOR_FRAME_MS)
    })
  }

  private cursorBounds(at: { x: number; y: number }): Electron.Rectangle {
    return {
      x: Math.round(at.x - CURSOR_TIP_DIP),
      y: Math.round(at.y - CURSOR_TIP_DIP),
      width: CURSOR_WINDOW_DIP,
      height: CURSOR_WINDOW_DIP
    }
  }

  private async showGlow(target: ComputerHighlightTarget): Promise<void> {
    const look = await trustedLook(appState.mainWindowRef)
    if (this.target !== target) return
    const page = computerHighlightPage(target.appName, look)
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
    this.mode = mode
    if (mode === 'glow') await this.showGlow(this.target)
    if (!this.target) return
    await this.syncPicture(this.target)
    if (!this.target) return
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
        if (!window.isVisible()) window.showInactive()
      } else if (window.isVisible()) {
        window.hide()
      }
    }
    if (this.cursor && !this.cursor.isDestroyed()) {
      if (mode === 'pill' && this.cursor.isVisible()) this.cursor.hide()
      else if (mode === 'glow' && !this.cursor.isVisible()) this.cursor.showInactive()
    } else if (mode === 'glow' && this.cursorAt) {
      // The agent acted while the app was out of sight; show where, now that it can be seen.
      void this.glide(this.cursorAt)
    }
    // A pointer move can also ask for this, and one timer is all there should ever be.
    if (this.following) clearTimeout(this.following)
    this.following = setTimeout(() => void this.follow(), FOLLOW_MS)
  }
}
