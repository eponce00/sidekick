import { promises as fs } from 'fs'
import { basename } from 'path'
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from 'electron'
import type { BrowserCaptureBox } from './browserScreenshotCapture'
import type {
  BrowserEmulationOptions,
  BrowserViewport,
  NativeBrowserRuntime,
  NativeBrowserSurface,
  NativeBrowserSurfaceCapture,
  NativeBrowserSurfaceConsoleMessage,
  NativeBrowserSurfaceLoadFailure
} from './nativeBrowserSessionService'

/** What the extension sends unasked. */
export type ChromeEvent =
  | { kind: 'cdp'; tabId: number; method: string; params: Record<string, unknown> }
  | { kind: 'tab'; tabId: number; url: string; title: string; loading: boolean }
  | { kind: 'removed'; tabId: number }
  | { kind: 'detached'; tabId: number; reason: string }
  | { kind: 'popup'; tabId: number; openerTabId: number; url: string; title: string }

/** Part of a picture of the viewport, enlarged, as a PNG. */
type CropPicture = (
  picture: Buffer,
  viewportWidth: number,
  box: BrowserCaptureBox,
  scale: number
) => Buffer

export interface ChromeLine {
  send: <T>(op: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<T>
  onEvent: (listener: (event: ChromeEvent) => void) => () => void
}

interface ChromeTabInfo {
  id: number
  title: string
  url: string
  active: boolean
  windowId: number
  loading: boolean
}

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 } as const

// Names as the browser tools write them, with what Chromium's input expects: key, code and Windows key code.
const NAMED_KEYS: Readonly<Record<string, readonly [string, string, number, string?]>> = {
  enter: ['Enter', 'Enter', 13, '\r'],
  return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  space: [' ', 'Space', 32, ' '],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  up: ['ArrowUp', 'ArrowUp', 38],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  down: ['ArrowDown', 'ArrowDown', 40],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39],
  arrowright: ['ArrowRight', 'ArrowRight', 39]
}

const CONSOLE_LEVELS: Readonly<Record<string, NativeBrowserSurfaceConsoleMessage['level']>> = {
  warning: 'warning',
  error: 'error',
  assert: 'error',
  debug: 'debug',
  info: 'info'
}

function keyEvent(
  name: string,
  modifiers: readonly string[]
): {
  key: string
  code?: string
  windowsVirtualKeyCode: number
  modifiers: number
  text?: string
} {
  const bits = modifiers.reduce(
    (all, modifier) =>
      all | (MODIFIER_BITS[modifier.toLowerCase() as keyof typeof MODIFIER_BITS] ?? 0),
    0
  )
  const named = NAMED_KEYS[name.toLowerCase()]
  // A key with ctrl, alt or meta held is a shortcut, not a character to type.
  const types = (bits & 7) === 0
  if (named) {
    const [key, code, vk, text] = named
    return {
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers: bits,
      ...(text && types ? { text } : {})
    }
  }
  const fn = /^f([1-9]|1[0-2])$/i.exec(name)
  if (fn) {
    return {
      key: `F${fn[1]}`,
      code: `F${fn[1]}`,
      windowsVirtualKeyCode: 0x6f + Number(fn[1]),
      modifiers: bits
    }
  }
  const upper = name.toUpperCase()
  return {
    key: name,
    ...(/^[A-Z]$/.test(upper) ? { code: `Key${upper}` } : {}),
    ...(/^[0-9]$/.test(name) ? { code: `Digit${name}` } : {}),
    windowsVirtualKeyCode: upper.charCodeAt(0),
    modifiers: bits,
    ...(name.length === 1 && types ? { text: name } : {})
  }
}

/** The MIME type a file sent to a page says it is, for the few that pages check. */
function mimeType(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? ''
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip'
  }
  return known[extension] ?? 'application/octet-stream'
}

/**
 * A tab in the user's own Chrome, behind the same surface the built-in browser's tabs have, so every
 * browser tool works on it. Its state arrives as messages, so the synchronous parts read what was last heard.
 */
class ChromeSurface implements NativeBrowserSurface {
  readonly webContentsId: number
  private url: string
  private title: string
  private loading: boolean
  private destroyed = false
  /** Input is fire-and-forget here, but has to reach the page in order. */
  private inputs: Promise<unknown> = Promise.resolve()
  /** The Enter that was sent already carried its text, so the character after it mustn't type it again. */
  private keyHadText = false
  /** A size the browser tools set, such as a phone's, to go back to. */
  private sizeOverride: Record<string, unknown> | undefined
  private readonly requests = new Map<string, { url: string; document: boolean }>()
  private readonly quiet = new AbortController().signal
  private readonly consoles = new Set<(message: NativeBrowserSurfaceConsoleMessage) => void>()
  private readonly failures = new Set<(failure: NativeBrowserSurfaceLoadFailure) => void>()
  private readonly debuggers = new Set<(method: string, params: Record<string, unknown>) => void>()
  private readonly destroyers = new Set<() => void>()
  private readonly openers = new Set<(surface: NativeBrowserSurface) => void>()

  constructor(
    private readonly line: ChromeLine,
    tab: ChromeTabInfo,
    /** The user's own tab, which is theirs to close and is never treated as ours. */
    readonly attached: boolean,
    private readonly showMark: (tabId: number, x: number, y: number) => void,
    private readonly fitPicture: (picture: Buffer, width: number, height: number) => Buffer,
    private readonly showLook: (tabId: number, data: string) => void,
    private readonly cropPicture: CropPicture,
    private readonly select: (tabId: number) => void
  ) {
    this.webContentsId = tab.id
    this.url = tab.url
    this.title = tab.title
    this.loading = tab.loading
  }

  private command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.line.send<T>('cdp', { tabId: this.webContentsId, method, params }, this.quiet)
  }

  /** From the runtime, for a message about this tab. */
  handle(
    event: ChromeEvent,
    adopt: (popup: ChromeEvent & { kind: 'popup' }) => ChromeSurface
  ): void {
    if (event.kind === 'tab') {
      this.url = event.url
      this.title = event.title
      this.loading = event.loading
    } else if (event.kind === 'removed') {
      this.destroy()
    } else if (event.kind === 'popup') {
      const surface = adopt(event)
      for (const listener of this.openers) listener(surface)
    } else if (event.kind === 'cdp') {
      this.handleCdp(event.method, event.params)
    }
  }

  private handleCdp(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string; url?: string } | undefined
      if (frame && !frame.parentId && frame.url) this.url = frame.url
    } else if (method === 'Page.navigatedWithinDocument') {
      if (typeof params.url === 'string') this.url = params.url
    } else if (method === 'Runtime.consoleAPICalled') {
      const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>
      const message: NativeBrowserSurfaceConsoleMessage = {
        level: CONSOLE_LEVELS[String(params.type)] ?? 'log',
        message: args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')
      }
      for (const listener of this.consoles) listener(message)
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as
        | {
            text?: string
            lineNumber?: number
            url?: string
            exception?: { description?: string }
          }
        | undefined
      const message: NativeBrowserSurfaceConsoleMessage = {
        level: 'error',
        message: details?.exception?.description ?? details?.text ?? 'Uncaught error',
        lineNumber: details?.lineNumber,
        sourceId: details?.url
      }
      for (const listener of this.consoles) listener(message)
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request as { url?: string } | undefined
      this.requests.set(String(params.requestId), {
        url: request?.url ?? '',
        document: params.type === 'Document'
      })
    } else if (method === 'Network.loadingFinished') {
      this.requests.delete(String(params.requestId))
    } else if (method === 'Network.loadingFailed') {
      const request = this.requests.get(String(params.requestId))
      this.requests.delete(String(params.requestId))
      if (request?.document) {
        const failure: NativeBrowserSurfaceLoadFailure = {
          url: request.url,
          errorText: String(params.errorText ?? 'The page could not be loaded'),
          canceled: params.canceled === true
        }
        for (const listener of this.failures) listener(failure)
      }
    }
    for (const listener of this.debuggers) listener(method, params)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of [...this.destroyers]) listener()
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isLoading(): boolean {
    return this.loading
  }

  async loadURL(url: string): Promise<void> {
    this.loading = true
    const tab = await this.line.send<ChromeTabInfo>(
      'navigate',
      { tabId: this.webContentsId, url },
      this.quiet
    )
    this.url = tab.url
    this.title = tab.title
    this.loading = tab.loading
  }

  /**
   * With the user's own cookies, as a download from this tab would be. Chrome follows redirects by itself
   * here: a manual one comes back to an extension with no status or address to go on.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const answer = await this.line.send<{
      status: number
      headers: Array<[string, string]>
      data: string
    }>('fetchFile', { url, method: init?.method ?? 'GET' }, this.quiet)
    return new Response(Buffer.from(answer.data, 'base64'), {
      status: answer.status,
      headers: answer.headers
    })
  }

  stop(): void {
    void this.command('Page.stopLoading').catch(() => undefined)
  }

  async close(): Promise<void> {
    // The user's own tab stays. This chat just stops using it.
    if (!this.attached) {
      await this.line
        .send('closeTab', { tabId: this.webContentsId }, this.quiet)
        .catch(() => undefined)
    }
    this.destroy()
  }

  focus(): void {
    // Not the window, which stays out of the user's way: the tab, unless it's one the user shared.
    if (!this.attached) this.select(this.webContentsId)
  }

  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    button: 'left' | 'middle' | 'right'
  ): Promise<void> {
    await this.inputs
    await this.line.send('drag', { tabId: this.webContentsId, from, to, button }, this.quiet)
  }

  async insertText(text: string): Promise<void> {
    await this.inputs
    await this.command('Input.insertText', { text })
  }

  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void {
    const send = (method: string, params: Record<string, unknown>): void => {
      this.inputs = this.inputs.then(() => this.command(method, params)).catch(() => undefined)
    }
    if (event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char') {
      const keyboard = event as KeyboardInputEvent
      if (keyboard.type === 'char') {
        if (this.keyHadText) this.keyHadText = false
        else send('Input.dispatchKeyEvent', { type: 'char', text: keyboard.keyCode })
        return
      }
      const key = keyEvent(keyboard.keyCode, (keyboard.modifiers ?? []) as string[])
      if (keyboard.type === 'keyDown') {
        this.keyHadText = Boolean(key.text)
        send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...key })
      } else {
        const { text: _text, ...up } = key
        send('Input.dispatchKeyEvent', { type: 'keyUp', ...up })
      }
      return
    }
    const mouse = event as MouseInputEvent
    const button = mouse.button ?? 'none'
    if (event.type === 'mouseWheel') {
      const wheel = event as MouseWheelInputEvent
      send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheel.x,
        y: wheel.y,
        // Electron's point the other way from Chromium's input.
        deltaX: -(wheel.deltaX ?? 0),
        deltaY: -(wheel.deltaY ?? 0)
      })
      return
    }
    const type =
      event.type === 'mouseDown'
        ? 'mousePressed'
        : event.type === 'mouseUp'
          ? 'mouseReleased'
          : 'mouseMoved'
    const pressed: Record<string, number> = { left: 1, right: 2, middle: 4 }
    send('Input.dispatchMouseEvent', {
      type,
      x: mouse.x,
      y: mouse.y,
      button,
      // A move with a button named is a drag, which a page only follows with the button held down.
      buttons: type === 'mouseReleased' ? 0 : (pressed[button] ?? 0),
      clickCount: mouse.clickCount ?? (type === 'mouseMoved' ? 0 : 1)
    })
  }

  showPointer(x: number, y: number): void {
    this.showMark(this.webContentsId, x, y)
  }

  resizeViewport(): void {
    // The window is the user's, and stays the size they left it.
  }

  async setAgentViewport(
    viewport: BrowserViewport,
    options: BrowserEmulationOptions = {}
  ): Promise<void> {
    await this.command('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 0,
      mobile: options.mobile === true
    })
    await this.command('Emulation.setTouchEmulationEnabled', { enabled: options.mobile === true })
    if (options.userAgent) {
      await this.command('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
    }
  }

  async clearAgentViewport(): Promise<void> {
    await this.command('Emulation.clearDeviceMetricsOverride')
    await this.command('Emulation.setTouchEmulationEnabled', { enabled: false })
  }

  async executeJavaScript<T>(source: string): Promise<T> {
    const answer = await this.command<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text ??
          'The page script failed'
      )
    }
    return answer.result?.value as T
  }

  /** In CSS pixels, so a point on the picture is that same point for a click. */
  async captureViewport(): Promise<NativeBrowserSurfaceCapture> {
    const metrics = await this.command<{
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
    }>('Page.getLayoutMetrics')
    const width = Math.round(metrics.cssVisualViewport?.clientWidth ?? 1280)
    const height = Math.round(metrics.cssVisualViewport?.clientHeight ?? 800)
    // No clip, which has Chromium lay the page out again to fit: a scrollbar narrower every time, in the
    // user's own tab. This is as it stands on their screen, at their screen's pixels.
    const shot = await this.command<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 90
    })
    this.showLook(this.webContentsId, shot.data)
    const png = this.fitPicture(Buffer.from(shot.data, 'base64'), width, height)
    return { png, width, height }
  }

  /** From the same picture as captureViewport: drawing it larger would mean resizing the user's tab. */
  async captureViewportPart(
    box: BrowserCaptureBox,
    scale: number
  ): Promise<NativeBrowserSurfaceCapture> {
    const metrics = await this.command<{
      cssVisualViewport?: { clientWidth: number; clientHeight: number }
    }>('Page.getLayoutMetrics')
    const shot = await this.command<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 95
    })
    const png = this.cropPicture(
      Buffer.from(shot.data, 'base64'),
      Math.round(metrics.cssVisualViewport?.clientWidth ?? 1280),
      box,
      scale
    )
    return { png, width: Math.round(box.width * scale), height: Math.round(box.height * scale) }
  }

  async attachDebugger(): Promise<void> {
    // The extension remembers these, and turns them back on whenever it has to attach again.
    for (const domain of ['Page', 'DOM', 'Runtime', 'Network', 'Accessibility']) {
      await this.command(`${domain}.enable`)
    }
  }

  detachDebugger(): void {
    // The extension lets go when the reply ends, and nothing else should cut a tab off.
  }

  async sendDebuggerCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    // Chrome only lets an extension hand a page files if the user has allowed it file access, so
    // they're passed through the page, as a page's own script could.
    if (method === 'DOM.setFileInputFiles') return (await this.setFiles(params ?? {})) as T
    await this.inputs
    if (method === 'Emulation.setDeviceMetricsOverride') this.sizeOverride = params
    if (method === 'Emulation.clearDeviceMetricsOverride') this.sizeOverride = undefined
    if (method === 'Page.captureScreenshot' && params?.captureBeyondViewport) {
      return (await this.captureWhole(params)) as T
    }
    return this.command<T>(method, params)
  }

  /**
   * Measured in Chrome: asked to capture past the screen by itself, it leaves the tab stretched to the page's
   * whole size. Asked for that size outright, it goes back when told.
   */
  private async captureWhole(params: Record<string, unknown>): Promise<unknown> {
    const clip = params.clip as { x: number; y: number; width: number; height: number }
    await this.command('Emulation.setDeviceMetricsOverride', {
      mobile: false,
      ...this.sizeOverride,
      // At a 3x screen's pixels a long page outgrows what the GPU will draw, and comes out part blank.
      deviceScaleFactor: 1,
      width: Math.ceil(clip.x + clip.width),
      height: Math.ceil(clip.y + clip.height)
    })
    try {
      // It has to draw at that size first, or what isn't drawn yet comes out blank.
      await this.command('Runtime.evaluate', {
        expression:
          'new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 1000) })',
        awaitPromise: true
      })
      return await this.command('Page.captureScreenshot', {
        ...params,
        captureBeyondViewport: false
      })
    } finally {
      // Straight from another scale, clearing leaves the tab at that size in the screen's pixels.
      await this.command('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false
      })
      await (this.sizeOverride
        ? this.command('Emulation.setDeviceMetricsOverride', this.sizeOverride)
        : this.command('Emulation.clearDeviceMetricsOverride'))
    }
  }

  private async setFiles(params: Record<string, unknown>): Promise<unknown> {
    const paths = (params.files ?? []) as string[]
    const files = await Promise.all(
      paths.map(async (path) => ({
        name: basename(path),
        type: mimeType(path),
        data: (await fs.readFile(path)).toString('base64')
      }))
    )
    const node = await this.command<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: params.backendNodeId,
      nodeId: params.nodeId,
      objectId: params.objectId
    })
    await this.command('Runtime.callFunctionOn', {
      objectId: node.object.objectId,
      arguments: [{ value: files }],
      awaitPromise: true,
      functionDeclaration: `function (files) {
        const transfer = new DataTransfer()
        for (const file of files) {
          const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))
          transfer.items.add(new File([bytes], file.name, { type: file.type }))
        }
        this.files = transfer.files
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      }`
    })
    return {}
  }

  setNavigationGuard(): void {
    // Chrome is what checks where a real tab goes. SideKick's own limits are in the policy.
  }

  setRequestGuard(): void {
    // The same.
  }

  setCertificateGuard(): void {
    // Chrome's own refusal stands for a certificate it doesn't trust.
  }

  onConsole(listener: (message: NativeBrowserSurfaceConsoleMessage) => void): () => void {
    this.consoles.add(listener)
    return () => this.consoles.delete(listener)
  }

  onLoadFailure(listener: (failure: NativeBrowserSurfaceLoadFailure) => void): () => void {
    this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  onDebuggerMessage(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void {
    this.debuggers.add(listener)
    return () => this.debuggers.delete(listener)
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyers.add(listener)
    return () => this.destroyers.delete(listener)
  }

  /** Chrome only says after it has opened a tab, so it gets taken as it is rather than opened again. */
  onOpenUrl(): () => void {
    return () => undefined
  }

  onOpenSurface(listener: (surface: NativeBrowserSurface) => void): () => void {
    this.openers.add(listener)
    return () => this.openers.delete(listener)
  }
}

/** Tabs in the user's Chrome, for the same service that drives the built-in browser's. */
export class ChromeBrowserRuntime implements NativeBrowserRuntime {
  readonly showsPdfsItself = true
  private readonly surfaces = new Map<number, ChromeSurface>()
  private windowId: number | undefined
  private selected: number | undefined
  private readonly quiet = new AbortController().signal

  constructor(
    private readonly line: ChromeLine,
    private readonly marks: {
      showPointer: (tabId: number, x: number, y: number) => void
      /** A picture at the screen's pixels, as a PNG of the size the page counts in. */
      fitPicture: (picture: Buffer, width: number, height: number) => Buffer
      /** The agent's latest look at a tab, for the user. */
      showLook: (tabId: number, data: string) => void
      cropPicture: CropPicture
    }
  ) {
    line.onEvent((event) => {
      const surface = this.surfaces.get(event.kind === 'popup' ? event.openerTabId : event.tabId)
      surface?.handle(event, (popup) =>
        this.remember(
          {
            id: popup.tabId,
            title: popup.title,
            url: popup.url,
            active: false,
            windowId: this.windowId ?? 0,
            loading: true
          },
          false
        )
      )
    })
  }

  private remember(tab: ChromeTabInfo, attached: boolean): ChromeSurface {
    const surface = new ChromeSurface(
      this.line,
      tab,
      attached,
      this.marks.showPointer,
      this.marks.fitPicture,
      this.marks.showLook,
      this.marks.cropPicture,
      (tabId) => {
        if (this.selected === tabId) return
        this.selected = tabId
        void this.line.send('selectTab', { tabId }, this.quiet).catch(() => undefined)
      }
    )
    this.surfaces.set(tab.id, surface)
    surface.onDestroyed(() => this.surfaces.delete(tab.id))
    return surface
  }

  async createSurface(): Promise<NativeBrowserSurface> {
    const tab = await this.line.send<ChromeTabInfo>(
      'open',
      { url: 'about:blank', ...(this.windowId ? { windowId: this.windowId } : {}) },
      this.quiet
    )
    this.windowId = tab.windowId
    this.selected = tab.id
    return this.remember(tab, false)
  }

  async attachSurface(tabId: number): Promise<NativeBrowserSurface> {
    const known = this.surfaces.get(tabId)
    if (known) return known
    const tab = await this.line.send<ChromeTabInfo>('tabInfo', { tabId }, this.quiet)
    return this.remember(tab, true)
  }
}
