import { randomUUID } from 'node:crypto'
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
  /** Marks are made one at a time, in the order the user made them. */
  work: Promise<void>
  hovering: boolean
  hoverAgain: boolean
  drawing: boolean
  drawAgain: boolean
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
  element?: { role?: string; tag: string; accessibleName?: string }
): string {
  if (target === 'area') return `Area ${Math.round(box.width)} × ${Math.round(box.height)}`
  const what = element?.role ?? element?.tag ?? 'element'
  const name = element?.accessibleName?.replace(/\s+/g, ' ').trim()
  const label = name ? `${what} “${name.length > 60 ? `${name.slice(0, 59)}…` : name}”` : what
  return label.slice(0, MAX_BROWSER_ANNOTATION_FIELD_CHARACTERS)
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
    this.renumber(scope)
    this.changed(conversationId)
  }

  setAnnotating(
    conversationId: string,
    on: boolean,
    colors: { accent?: unknown; accentText?: unknown } = {}
  ): void {
    const scope = this.scope(conversationId)
    scope.annotating = on
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
    return { page, scale: placement.scale }
  }

  input(conversationId: string, input: BrowserAnnotationOverlayInput): void {
    const scope = this.scopes.get(conversationId)
    if (!scope?.annotating) return
    if (input.type === 'escape') {
      if (scope.press?.dragging) {
        scope.press = undefined
        void this.draw(conversationId)
      } else this.setAnnotating(conversationId, false)
      return
    }
    if (input.type === 'leave') {
      scope.pointer = undefined
      scope.hover = undefined
      // A drag that leaves the page ends where it last was.
      if (scope.press?.dragging) this.finishPress(conversationId, scope, scope.press.last)
      scope.press = undefined
      void this.draw(conversationId)
      return
    }
    if (input.type === 'wheel') {
      if (scope.webContentsId !== undefined)
        this.options.scroll(conversationId, scope.webContentsId, input)
      setTimeout(() => {
        this.hoverAt(conversationId)
        void this.draw(conversationId)
      }, 80)
      return
    }
    const point = { x: input.x, y: input.y }
    if (input.type === 'down') {
      scope.press = { ...point, dragging: false, last: point }
      return
    }
    if (input.type === 'move') {
      scope.pointer = point
      const press = scope.press
      if (press && input.buttons) {
        press.last = point
        if (Math.hypot(point.x - press.x, point.y - press.y) >= DRAG_THRESHOLD) {
          press.dragging = true
          scope.hover = undefined
        }
        if (press.dragging) {
          void this.draw(conversationId)
          return
        }
      } else if (press) {
        // The button came up outside the page.
        if (press.dragging) this.finishPress(conversationId, scope, press.last)
        scope.press = undefined
      }
      this.hoverAt(conversationId)
      return
    }
    if (input.type === 'up' && scope.press) {
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

  private async mark(
    conversationId: string,
    at: { x: number; y: number } | BrowserAnnotationBox,
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
      'width' in at
        ? { x: at.x / scale, y: at.y / scale, width: at.width / scale, height: at.height / scale }
        : undefined
    const probe = area
      ? { x: area.x + area.width / 2, y: area.y + area.height / 2 }
      : { x: at.x / scale, y: at.y / scale }
    const hit = await annotationHitTest(send, probe.x, probe.y)
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
      name: markName(target, box, element),
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
    this.changed(conversationId, { focus: attachment.id })
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
              number: mark.attachment.number,
              area: mark.attachment.target === 'area'
            })
        }
        const press = scope.press
        overlay.render({
          accent: scope.accent,
          accentText: scope.accentText,
          marks,
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
