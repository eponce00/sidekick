import { randomUUID } from 'node:crypto'
import { browserMarkName } from '../../shared/browserMarkNames'
import type { BrowserWindow } from 'electron'
import {
  MAX_BROWSER_ANNOTATIONS,
  type BrowserAnnotationSummary,
  type BrowserAnnotationsChange,
  type BrowserPanelBounds
} from '../../shared/browserWorkspace'
import {
  MAX_BROWSER_ANNOTATION_FIELD_CHARACTERS,
  MAX_BROWSER_ANNOTATION_IMAGE_BYTES,
  MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS,
  MAX_BROWSER_ANNOTATION_URL_CHARACTERS,
  type BrowserAnnotationAttachment,
  type BrowserAnnotationBox
} from '../../shared/messageContextAttachments'
import {
  annotationDocument,
  annotationHitTest,
  annotationMaskBoxes,
  annotationCropBox,
  annotationNodeBox,
  annotationViewport,
  captureAnnotationPicture,
  clampBox,
  describeAnnotationElement,
  type BrowserAnnotationCdp,
  type BrowserAnnotationHit
} from './browserAnnotationCapture'
import type {
  BrowserAnnotationOverlayHandle,
  BrowserAnnotationOverlayInput,
  BrowserAnnotationOverlayState
} from './browserAnnotationOverlay'
import {
  ANNOTATION_STYLE_PROPERTIES,
  annotationStyleValue,
  type AnnotationStyleValues
} from '../../shared/annotationOverlay'

/** The active tab of a conversation's browser, as marks are made on it. */
export interface BrowserAnnotationPage {
  tabId: string
  webContentsId: number
  url: string
  title: string
  send: BrowserAnnotationCdp
  /** A stored sign-in's password is shown as plain text on the page; no picture is taken. */
  secretShownAsText(): Promise<boolean>
}

export interface BrowserAnnotationControllerOptions {
  page(conversationId: string): BrowserAnnotationPage | undefined
  placement(
    webContentsId: number
  ): { host: BrowserWindow; bounds: BrowserPanelBounds; scale: number } | undefined
  overlay(
    host: BrowserWindow,
    onInput: (input: BrowserAnnotationOverlayInput) => void
  ): Promise<BrowserAnnotationOverlayHandle>
  /** Scrolls the page as the user's own wheel would, if they may use the page now. */
  scroll(
    conversationId: string,
    webContentsId: number,
    input: { x: number; y: number; deltaX: number; deltaY: number }
  ): void
  notify(change: BrowserAnnotationsChange): void
}

interface StoredMark {
  attachment: BrowserAnnotationAttachment
  webContentsId: number
  url: string
  backendNodeId?: number
  /** An area, in document CSS pixels, so it moves with the page as it scrolls. */
  documentBox?: BrowserAnnotationBox
}

interface Scope {
  annotating: boolean
  accent: string
  accentText: string
  marks: StoredMark[]
  host?: BrowserWindow
  webContentsId?: number
  hover?: BrowserAnnotationHit
  pointer?: { x: number; y: number }
  press?: { x: number; y: number; dragging: boolean; last: { x: number; y: number } }
  /** The mark whose note is open on the page. */
  editing?: string
  markersHidden: boolean
  theme: 'dark' | 'light'
  /**
   * A mark's element restyled live from the editor: the styles it opened with, the element's own
   * style attribute to put back, and what the user changed.
   */
  restyle?: {
    id: string
    nodeId: number
    original: string | null
    values: AnnotationStyleValues
    changed: AnnotationStyleValues
  }
  canDictate: boolean
  dictation?: { listening: boolean; heard?: { seq: number; text: string; final: boolean } }
  /** Marks are made one at a time, in the order the user made them. */
  work: Promise<void>
  hovering: boolean
  hoverAgain: boolean
  drawing: boolean
  drawAgain: boolean
}

/**
 * How long one call to the page's debugger may take while annotating. A page that is busy, such as
 * with the agent's action, or navigating can leave a call unanswered; that one step then fails
 * instead of leaving the hover, drawing or marking waiting on it for good.
 */
export const PAGE_CALL_TIMEOUT_MS = 5_000

export function withPageTimeout(
  send: BrowserAnnotationCdp,
  timeoutMs = PAGE_CALL_TIMEOUT_MS
): BrowserAnnotationCdp {
  return <T>(method: string, params?: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The page did not answer in time (${method})`)),
        timeoutMs
      )
      send<T>(method, params).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
}

/** A drag shorter than this is a click on the element under it. */
const DRAG_THRESHOLD = 5
const MIN_AREA = 8
const DEFAULT_ACCENT = '#3b82f6'
const DEFAULT_ACCENT_TEXT = '#ffffff'

/** Only a plain color reaches the overlay's style. */
export function safeAccent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,/+-]+\)$/i.test(color)) return color
  return undefined
}

function round(box: BrowserAnnotationBox): BrowserAnnotationBox {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  }
}

/** The page's address without any user name or password in it. */
function shownUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.href.slice(0, MAX_BROWSER_ANNOTATION_URL_CHARACTERS)
  } catch {
    return url.replace(/[\0\r\n]/g, '').slice(0, MAX_BROWSER_ANNOTATION_URL_CHARACTERS)
  }
}

function markName(
  target: 'element' | 'area',
  box: BrowserAnnotationBox,
  element?: { role?: string; tag: string; accessibleName?: string; text?: string }
): string {
  if (target === 'area') return `Area ${Math.round(box.width)} × ${Math.round(box.height)}`
  return browserMarkName(element ?? {}).slice(0, MAX_BROWSER_ANNOTATION_FIELD_CHARACTERS)
}

/**
 * Marks the user makes on browser pages, per conversation, until they are sent with a message.
 * They live only in the main process and are kept until sent, removed, or SideKick quits.
 */
export class BrowserAnnotationController {
  private readonly scopes = new Map<string, Scope>()
  private readonly overlays = new Map<BrowserWindow, Promise<BrowserAnnotationOverlayHandle>>()
  /** Which conversation each window's overlay is drawing. */
  private readonly hostScope = new Map<BrowserWindow, string>()

  constructor(private readonly options: BrowserAnnotationControllerOptions) {}

  private scope(conversationId: string): Scope {
    let scope = this.scopes.get(conversationId)
    if (!scope) {
      scope = {
        annotating: false,
        accent: DEFAULT_ACCENT,
        accentText: DEFAULT_ACCENT_TEXT,
        marks: [],
        markersHidden: false,
        theme: 'dark',
        canDictate: false,
        work: Promise.resolve(),
        hovering: false,
        hoverAgain: false,
        drawing: false,
        drawAgain: false
      }
      this.scopes.set(conversationId, scope)
    }
    return scope
  }

  panelState(conversationId: string): {
    annotating: boolean
    annotations: BrowserAnnotationSummary[]
  } {
    const scope = this.scopes.get(conversationId)
    const page = scope?.marks.length ? this.options.page(conversationId) : undefined
    return {
      annotating: Boolean(scope?.annotating),
      annotations: (scope?.marks ?? []).map((mark) => ({
        id: mark.attachment.id,
        number: mark.attachment.number,
        name: mark.attachment.name,
        note: mark.attachment.note,
        target: mark.attachment.target,
        onPage: Boolean(page && this.onPage(mark, page))
      }))
    }
  }

  /** The marks as message attachments, pictures included, in their numbered order. */
  list(conversationId: string): BrowserAnnotationAttachment[] {
    return (this.scopes.get(conversationId)?.marks ?? []).map((mark) => mark.attachment)
  }

  /** Hands the marks to a message being sent; they leave the page and the panel. */
  take(conversationId: string, ids: readonly string[]): BrowserAnnotationAttachment[] {
    const scope = this.scopes.get(conversationId)
    if (!scope) return []
    const wanted = new Set(ids)
    const taken = scope.marks.filter((mark) => wanted.has(mark.attachment.id))
    if (!taken.length) return []
    scope.marks = scope.marks.filter((mark) => !wanted.has(mark.attachment.id))
    this.renumber(scope)
    this.changed(conversationId)
    return taken.map((mark) => mark.attachment)
  }

  setNote(conversationId: string, id: string, note: string): void {
    const mark = this.scopes.get(conversationId)?.marks.find((m) => m.attachment.id === id)
    if (!mark) throw new Error('That mark is no longer on the page')
    mark.attachment = {
      ...mark.attachment,
      note: note.replace(/\r\n?/g, '\n').slice(0, MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS)
    }
    this.changed(conversationId)
  }

  remove(conversationId: string, id: string): void {
    const scope = this.scopes.get(conversationId)
    if (!scope) return
    const before = scope.marks.length
    scope.marks = scope.marks.filter((mark) => mark.attachment.id !== id)
    if (scope.marks.length === before) return
    if (scope.editing === id) scope.editing = undefined
    this.renumber(scope)
    this.changed(conversationId)
  }

  /** Removes every mark on every page of the conversation. */
  clear(conversationId: string): void {
    const scope = this.scopes.get(conversationId)
    if (!scope?.marks.length) return
    scope.marks = []
    scope.editing = undefined
    this.changed(conversationId)
  }

  setAnnotating(
    conversationId: string,
    on: boolean,
    colors: { accent?: unknown; accentText?: unknown; theme?: unknown; canDictate?: unknown } = {}
  ): void {
    const scope = this.scope(conversationId)
    scope.annotating = on
    if (colors.theme === 'dark' || colors.theme === 'light') scope.theme = colors.theme
    if (typeof colors.canDictate === 'boolean') scope.canDictate = colors.canDictate
    if (!on) {
      scope.editing = undefined
      void this.endStyle(conversationId, scope, false)
      this.stopDictation(conversationId, scope)
    }
    scope.accent = safeAccent(colors.accent) ?? scope.accent
    scope.accentText = safeAccent(colors.accentText) ?? scope.accentText
    scope.hover = undefined
    scope.press = undefined
    if (!on) {
      for (const [host, owner] of this.hostScope) {
        if (owner === conversationId) void this.hideHost(host)
      }
    }
    this.changed(conversationId)
  }

  /**
   * Follows the panel: called each time it lays the conversation's page out in a window, so the
   * overlay stays exactly over the page while the user annotates.
   */
  async sync(host: BrowserWindow, conversationId: string, webContentsId: number): Promise<void> {
    const scope = this.scopes.get(conversationId)
    if (!scope?.annotating) {
      if (this.hostScope.get(host) === conversationId) await this.hideHost(host)
      return
    }
    const placement = this.options.placement(webContentsId)
    if (!placement || placement.host !== host) return
    if (scope.webContentsId !== webContentsId) {
      scope.hover = undefined
      scope.press = undefined
    }
    scope.host = host
    scope.webContentsId = webContentsId
    this.hostScope.set(host, conversationId)
    const overlay = await this.overlayFor(host)
    if (!this.scopes.get(conversationId)?.annotating || this.hostScope.get(host) !== conversationId)
      return
    overlay.place(placement.bounds)
    void this.draw(conversationId)
  }

  async hideHost(host: BrowserWindow): Promise<void> {
    this.hostScope.delete(host)
    const overlay = await this.overlays.get(host)
    if (!this.hostScope.has(host)) overlay?.hide()
  }

  private overlayFor(host: BrowserWindow): Promise<BrowserAnnotationOverlayHandle> {
    let overlay = this.overlays.get(host)
    if (!overlay) {
      overlay = this.options.overlay(host, (input) => {
        const conversationId = this.hostScope.get(host)
        if (conversationId) this.input(conversationId, input)
      })
      this.overlays.set(host, overlay)
      overlay.catch(() => this.overlays.delete(host))
      host.once('closed', () => {
        this.overlays.delete(host)
        this.hostScope.delete(host)
      })
    }
    return overlay
  }

  private renumber(scope: Scope): void {
    scope.marks.forEach((mark, index) => {
      if (mark.attachment.number !== index + 1)
        mark.attachment = { ...mark.attachment, number: index + 1 }
    })
  }

  private changed(conversationId: string, change: Partial<BrowserAnnotationsChange> = {}): void {
    this.options.notify({ conversationId, ...change })
    void this.draw(conversationId)
  }

  private onPage(mark: StoredMark, page: BrowserAnnotationPage): boolean {
    return mark.webContentsId === page.webContentsId && mark.url === page.url
  }

  /** The page the overlay covers, while it is still the active tab the user sees. */
  private livePage(
    conversationId: string,
    scope: Scope
  ): { page: BrowserAnnotationPage; scale: number } | undefined {
    const page = this.options.page(conversationId)
    if (!page || page.webContentsId !== scope.webContentsId) return undefined
    const placement = this.options.placement(page.webContentsId)
    if (!placement || placement.host !== scope.host || !(placement.scale > 0)) return undefined
    return { page: { ...page, send: withPageTimeout(page.send) }, scale: placement.scale }
  }

  input(conversationId: string, message: BrowserAnnotationOverlayInput): void {
    const scope = this.scopes.get(conversationId)
    if (!scope?.annotating) return
    switch (message.type) {
      case 'stop':
        if (scope.press?.dragging) {
          scope.press = undefined
          void this.draw(conversationId)
        } else this.setAnnotating(conversationId, false)
        return
      case 'edit': {
        const next =
          message.id && scope.marks.some((mark) => mark.attachment.id === message.id)
            ? message.id
            : undefined
        if (next !== scope.editing) {
          this.stopDictation(conversationId, scope)
          // Another note, or none: the changes made so far stay on the page.
          void this.endStyle(conversationId, scope, true)
        }
        scope.editing = next
        void this.draw(conversationId)
        return
      }
      case 'styleOpen':
        scope.work = scope.work
          .then(() => this.openStyle(conversationId, scope, message.id))
          .catch((error: unknown) =>
            this.options.notify({
              conversationId,
              error: `Could not read that element's style: ${error instanceof Error ? error.message : String(error)}`
            })
          )
        return
      case 'style':
        scope.work = scope.work
          .then(() => this.applyStyle(conversationId, scope, message.id, message.styles))
          .catch(() => undefined)
        return
      case 'styleDone':
        if (scope.restyle?.id === message.id)
          scope.work = scope.work.then(() => this.endStyle(conversationId, scope, message.keep))
        return
      case 'dictate':
        if (!message.on) {
          // The last words still being transcribed reach the note before the app says it is done.
          if (scope.dictation?.listening) {
            scope.dictation = { ...scope.dictation, listening: false }
            this.options.notify({ conversationId, dictate: false })
            void this.draw(conversationId)
          }
        } else if (scope.canDictate && scope.editing && !scope.dictation?.listening) {
          scope.dictation = { listening: true }
          this.options.notify({ conversationId, dictate: true })
          void this.draw(conversationId)
        }
        return
      case 'note':
        if (scope.marks.some((mark) => mark.attachment.id === message.id))
          this.setNote(conversationId, message.id, message.note)
        return
      case 'remove':
        this.remove(conversationId, message.id)
        return
      case 'clear':
        this.clear(conversationId)
        return
      case 'markers':
        scope.markersHidden = message.hidden
        void this.draw(conversationId)
        return
      case 'screenshot':
        void this.screenshot(conversationId)
        return
      case 'send':
        // The chat sends its message with the marks, as its send button would.
        scope.editing = undefined
        this.options.notify({ conversationId, send: true })
        return
      case 'wheel':
        if (scope.webContentsId !== undefined)
          this.options.scroll(conversationId, scope.webContentsId, message)
        setTimeout(() => {
          this.hoverAt(conversationId)
          void this.draw(conversationId)
        }, 80)
        return
      case 'pointer':
        this.pointer(conversationId, scope, message.kind, { x: message.x, y: message.y })
    }
  }

  private pointer(
    conversationId: string,
    scope: Scope,
    kind: 'move' | 'down' | 'up' | 'leave',
    point: { x: number; y: number }
  ): void {
    if (kind === 'leave') {
      scope.pointer = undefined
      scope.hover = undefined
      // A drag that leaves the page ends where it last was.
      if (scope.press?.dragging) this.finishPress(conversationId, scope, scope.press.last)
      scope.press = undefined
      void this.draw(conversationId)
      return
    }
    if (kind === 'down') {
      scope.press = { ...point, dragging: false, last: point }
      return
    }
    if (kind === 'move') {
      scope.pointer = point
      const press = scope.press
      if (press) {
        press.last = point
        if (Math.hypot(point.x - press.x, point.y - press.y) >= DRAG_THRESHOLD) {
          press.dragging = true
          scope.hover = undefined
        }
        if (press.dragging) {
          void this.draw(conversationId)
          return
        }
      }
      this.hoverAt(conversationId)
      return
    }
    if (scope.press) {
      this.finishPress(conversationId, scope, point)
      scope.press = undefined
    }
  }

  private finishPress(conversationId: string, scope: Scope, end: { x: number; y: number }): void {
    const press = scope.press
    if (!press) return
    const area = press.dragging
      ? {
          x: Math.min(press.x, end.x),
          y: Math.min(press.y, end.y),
          width: Math.abs(end.x - press.x),
          height: Math.abs(end.y - press.y)
        }
      : undefined
    if (area && (area.width < MIN_AREA || area.height < MIN_AREA)) return
    const at = { x: press.x, y: press.y }
    scope.work = scope.work
      .then(() => this.mark(conversationId, area ?? at, area ? 'area' : 'element'))
      .catch((error: unknown) =>
        this.options.notify({
          conversationId,
          error: `Could not mark that place: ${error instanceof Error ? error.message : String(error)}`
        })
      )
  }

  /** Finds what is under the pointer; only the latest point is looked up. */
  private hoverAt(conversationId: string): void {
    const scope = this.scopes.get(conversationId)
    if (!scope) return
    if (scope.hovering) {
      scope.hoverAgain = true
      return
    }
    scope.hovering = true
    void (async () => {
      try {
        do {
          scope.hoverAgain = false
          const pointer = scope.pointer
          const live = this.livePage(conversationId, scope)
          if (!pointer || !live || scope.press?.dragging) {
            scope.hover = undefined
            break
          }
          scope.hover = await annotationHitTest(
            live.page.send,
            pointer.x / live.scale,
            pointer.y / live.scale
          )
          await this.draw(conversationId)
        } while (scope.hoverAgain && scope.annotating)
      } finally {
        scope.hovering = false
      }
    })()
  }

  /** What the app window heard for the open note, or that it stopped listening. */
  dictated(
    conversationId: string,
    heard: { listening: boolean; text?: string; final?: boolean }
  ): void {
    const scope = this.scopes.get(conversationId)
    if (!scope?.dictation) return
    if (typeof heard.text === 'string') {
      scope.dictation = {
        listening: scope.dictation.listening,
        heard: {
          seq: (scope.dictation.heard?.seq ?? 0) + 1,
          text: heard.text.slice(0, MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS),
          final: heard.final === true
        }
      }
    } else if (!heard.listening) scope.dictation = undefined
    void this.draw(conversationId)
  }

  private stopDictation(conversationId: string, scope: Scope): void {
    if (!scope.dictation) return
    scope.dictation = undefined
    this.options.notify({ conversationId, dictate: false })
    void this.draw(conversationId)
  }

  /** Reads a marked element's styles for the editor, from the page as it is now. */
  private async openStyle(conversationId: string, scope: Scope, id: string): Promise<void> {
    if (!scope.annotating) return
    await this.endStyle(conversationId, scope, true)
    const mark = scope.marks.find((item) => item.attachment.id === id)
    const live = this.livePage(conversationId, scope)
    if (!mark?.backendNodeId || !live || !this.onPage(mark, live.page)) return
    const { send } = live.page
    const pushed = await send<{ nodeIds?: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [mark.backendNodeId]
    })
    const nodeId = pushed.nodeIds?.[0]
    if (!nodeId) throw new Error('The element is no longer on the page')
    await send('CSS.enable').catch(() => undefined)
    const [computed, attributes] = await Promise.all([
      send<{ computedStyle?: Array<{ name: string; value: string }> }>(
        'CSS.getComputedStyleForNode',
        { nodeId }
      ),
      send<{ attributes?: string[] }>('DOM.getAttributes', { nodeId })
    ])
    const values: AnnotationStyleValues = {}
    for (const property of ANNOTATION_STYLE_PROPERTIES) {
      // The page's own values, kept only when they are plain CSS.
      const value = annotationStyleValue(
        computed.computedStyle?.find((entry) => entry.name === property)?.value
      )
      if (value) values[property] = value
    }
    const list = attributes.attributes ?? []
    const at = list.findIndex((name, index) => index % 2 === 0 && name === 'style')
    scope.restyle = {
      id,
      nodeId,
      original: at >= 0 ? (list[at + 1] ?? '') : null,
      values,
      changed: {}
    }
    await this.draw(conversationId)
  }

  /** Shows the user's changes on the element at once, over its own style. */
  private async applyStyle(
    conversationId: string,
    scope: Scope,
    id: string,
    styles: AnnotationStyleValues
  ): Promise<void> {
    const restyle = scope.restyle
    const live = this.livePage(conversationId, scope)
    if (!restyle || restyle.id !== id || !live) return
    restyle.changed = { ...restyle.changed, ...styles }
    const added = Object.entries(restyle.changed)
      .filter(([, value]) => value)
      .map(([property, value]) => `${property}: ${value} !important`)
      .join('; ')
    const own = restyle.original?.trim()
    const base = own ? own.replace(/;?$/, ';') : ''
    await live.page.send('DOM.setAttributeValue', {
      nodeId: restyle.nodeId,
      name: 'style',
      value: added ? `${base} ${added}`.trim() : (restyle.original ?? '')
    })
    await this.draw(conversationId)
  }

  /** Closes the editor; without `keep` the element gets its own style back. */
  private async endStyle(conversationId: string, scope: Scope, keep: boolean): Promise<void> {
    const restyle = scope.restyle
    if (!restyle) return
    scope.restyle = undefined
    const live = this.livePage(conversationId, scope)
    if (!keep && live && Object.keys(restyle.changed).length) {
      await (
        restyle.original === null
          ? live.page.send('DOM.removeAttribute', { nodeId: restyle.nodeId, name: 'style' })
          : live.page.send('DOM.setAttributeValue', {
              nodeId: restyle.nodeId,
              name: 'style',
              value: restyle.original
            })
      ).catch(() => undefined)
    }
    await this.draw(conversationId)
  }

  /** Marks all of the page in view, as a picture the user can write a note for. */
  screenshot(conversationId: string): Promise<void> {
    const scope = this.scopes.get(conversationId)
    if (!scope?.annotating) return Promise.resolve()
    scope.work = scope.work
      .then(() => this.mark(conversationId, 'view', 'area'))
      .catch((error: unknown) =>
        this.options.notify({
          conversationId,
          error: `Could not take a screenshot: ${error instanceof Error ? error.message : String(error)}`
        })
      )
    return scope.work
  }

  private async mark(
    conversationId: string,
    at: { x: number; y: number } | BrowserAnnotationBox | 'view',
    target: 'element' | 'area'
  ): Promise<void> {
    const scope = this.scopes.get(conversationId)
    if (!scope?.annotating) return
    if (scope.marks.length >= MAX_BROWSER_ANNOTATIONS) {
      this.options.notify({
        conversationId,
        error: `A message can point at up to ${MAX_BROWSER_ANNOTATIONS} places. Send these first, or remove one.`
      })
      return
    }
    const live = this.livePage(conversationId, scope)
    if (!live) return
    const { page, scale } = live
    const { send } = page
    const viewport = await annotationViewport(send)
    // The overlay's pixels are window pixels; the page's are CSS pixels at the panel's scale.
    const area: BrowserAnnotationBox | undefined =
      at === 'view'
        ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
        : 'width' in at
          ? { x: at.x / scale, y: at.y / scale, width: at.width / scale, height: at.height / scale }
          : undefined
    const probe = area
      ? { x: area.x + area.width / 2, y: area.y + area.height / 2 }
      : at !== 'view' && { x: at.x / scale, y: at.y / scale }
    // A screenshot is of the whole view, not of what lies at its middle.
    const hit =
      at === 'view' || !probe ? undefined : await annotationHitTest(send, probe.x, probe.y)
    const box = area ?? hit?.box
    if (!box) return
    const visible = clampBox(box, viewport.width, viewport.height)
    const document = await annotationDocument(send)
    const element = hit
      ? await describeAnnotationElement(send, document, hit.backendNodeId)
      : undefined
    const crop = visible && annotationCropBox(visible, viewport)
    const picture =
      crop && !(await page.secretShownAsText())
        ? await captureAnnotationPicture(
            send,
            viewport,
            box,
            await annotationMaskBoxes(send, document, crop),
            MAX_BROWSER_ANNOTATION_IMAGE_BYTES
          )
        : undefined
    // The page may have moved on while it was read; a mark belongs to what the user saw.
    if (this.options.page(conversationId)?.webContentsId !== page.webContentsId) return
    if (!scope.annotating || scope.marks.length >= MAX_BROWSER_ANNOTATIONS) return
    const attachment: BrowserAnnotationAttachment = {
      id: randomUUID(),
      kind: 'browser',
      // Named by the clicked element's tag when its details could not be read.
      name:
        at === 'view'
          ? 'Screenshot of the page'
          : markName(target, box, element ?? (hit ? { tag: hit.tag } : undefined)),
      number: scope.marks.length + 1,
      note: '',
      url: shownUrl(page.url),
      ...(page.title
        ? { title: page.title.slice(0, MAX_BROWSER_ANNOTATION_FIELD_CHARACTERS) }
        : {}),
      target,
      ...(element?.selector ? { selector: element.selector } : {}),
      ...(element?.role ? { role: element.role } : {}),
      ...(element?.accessibleName ? { accessibleName: element.accessibleName } : {}),
      ...(element?.text ? { text: element.text } : {}),
      box: round(box),
      viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
      ...(picture ? { image: picture } : {})
    }
    scope.marks.push({
      attachment,
      webContentsId: page.webContentsId,
      url: page.url,
      ...(target === 'element' && hit ? { backendNodeId: hit.backendNodeId } : {}),
      ...(target === 'area'
        ? { documentBox: { ...box, x: box.x + viewport.pageX, y: box.y + viewport.pageY } }
        : {})
    })
    scope.hover = undefined
    scope.editing = attachment.id
    this.changed(conversationId)
  }

  /** Draws the marks on this page where they are now, with the hover box or the area being dragged. */
  private async draw(conversationId: string): Promise<void> {
    const scope = this.scopes.get(conversationId)
    if (!scope?.host || this.hostScope.get(scope.host) !== conversationId) return
    if (scope.drawing) {
      scope.drawAgain = true
      return
    }
    scope.drawing = true
    try {
      do {
        scope.drawAgain = false
        const overlay = await this.overlays.get(scope.host)
        const live = this.livePage(conversationId, scope)
        if (!overlay?.visible || !live) return
        const { page, scale } = live
        const toOverlay = (box: BrowserAnnotationBox): BrowserAnnotationBox => ({
          x: box.x * scale,
          y: box.y * scale,
          width: box.width * scale,
          height: box.height * scale
        })
        const onPage = scope.marks.filter((mark) => this.onPage(mark, page))
        const viewport = onPage.some((mark) => mark.documentBox)
          ? await annotationViewport(page.send).catch(() => undefined)
          : undefined
        const marks: BrowserAnnotationOverlayState['marks'] = []
        for (const mark of onPage) {
          const box = mark.backendNodeId
            ? await annotationNodeBox(page.send, mark.backendNodeId)
            : mark.documentBox && viewport
              ? {
                  ...mark.documentBox,
                  x: mark.documentBox.x - viewport.pageX,
                  y: mark.documentBox.y - viewport.pageY
                }
              : undefined
          if (box)
            marks.push({
              ...toOverlay(box),
              id: mark.attachment.id,
              number: mark.attachment.number,
              area: mark.attachment.target === 'area',
              name: mark.attachment.name,
              note: mark.attachment.note
            })
        }
        const press = scope.press
        overlay.render({
          accent: scope.accent,
          accentText: scope.accentText,
          theme: scope.theme,
          marks,
          markersHidden: scope.markersHidden,
          canDictate: scope.canDictate,
          ...(scope.dictation ? { dictation: scope.dictation } : {}),
          ...(scope.restyle && scope.restyle.id === scope.editing
            ? { style: { id: scope.restyle.id, values: scope.restyle.values } }
            : {}),
          ...(scope.editing && marks.some((mark) => mark.id === scope.editing)
            ? { editing: scope.editing }
            : {}),
          ...(press?.dragging
            ? {
                drag: {
                  x: Math.min(press.x, press.last.x),
                  y: Math.min(press.y, press.last.y),
                  width: Math.abs(press.last.x - press.x),
                  height: Math.abs(press.last.y - press.y)
                }
              }
            : scope.hover
              ? { hover: { ...toOverlay(scope.hover.box), label: scope.hover.label } }
              : {})
        })
      } while (scope.drawAgain)
    } finally {
      scope.drawing = false
    }
  }
}
