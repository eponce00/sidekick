import type { BrowserAnnotationBox } from '../../shared/messageContextAttachments'
import { browserMarkKind } from '../../shared/browserMarkNames'

/**
 * What a mark on a page says about it, read over the Chrome DevTools Protocol from the trusted
 * main process. Nothing here runs in the page: the page cannot see a mark being made, change
 * what is read, or answer in place of Chromium. No form field's value is read, and the picture
 * covers the places a value could show.
 */
export type BrowserAnnotationCdp = <T>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>

export interface CdpDomNode {
  nodeId?: number
  backendNodeId: number
  nodeType: number
  nodeName: string
  localName?: string
  nodeValue?: string
  attributes?: string[]
  children?: CdpDomNode[]
  shadowRoots?: CdpDomNode[]
  contentDocument?: CdpDomNode
  templateContent?: CdpDomNode
  pseudoElements?: CdpDomNode[]
  frameId?: string
}

export interface BrowserAnnotationViewport {
  width: number
  height: number
  /** Where the viewport is in the document, in CSS pixels. */
  pageX: number
  pageY: number
  /** Device pixels to a CSS pixel, which Chromium multiplies a screenshot's own scale by. */
  devicePixelRatio?: number
}

export interface BrowserAnnotationHit {
  backendNodeId: number
  box: BrowserAnnotationBox
  /** `button.primary`, as the hover label shows it. */
  label: string
  /** The element's tag, which names a mark whose details could not be read. */
  tag: string
}

export interface BrowserAnnotationElement {
  selector: string
  tag: string
  role?: string
  accessibleName?: string
  text?: string
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const MAX_TEXT = 500
const MAX_SELECTOR_STEPS = 10
const MAX_MASKS = 400

/** Input types whose box shows typed text or a chosen value. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'range',
  'color',
  'file',
  'image',
  'hidden'
])
const SKIPPED_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'input',
  'textarea',
  'select',
  'option',
  'datalist'
])
const TEXT_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
/** Roles too generic to tell the agent anything. */
const QUIET_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'GenericContainer',
  'InlineTextBox'
])

function attributeMap(node: CdpDomNode): Map<string, string> {
  const map = new Map<string, string>()
  const list = node.attributes ?? []
  for (let index = 0; index + 1 < list.length; index += 2) {
    map.set(list[index].toLowerCase(), list[index + 1])
  }
  return map
}

function tagOf(node: CdpDomNode): string {
  return (node.localName || node.nodeName || '').toLowerCase()
}

/** Shows typed text, a chosen value, or anything the user writes into. */
export function isValueBearing(node: CdpDomNode): boolean {
  if (node.nodeType !== ELEMENT_NODE) return false
  const tag = tagOf(node)
  const attributes = attributeMap(node)
  if (tag === 'input') {
    return !NON_TEXT_INPUT_TYPES.has((attributes.get('type') ?? 'text').trim().toLowerCase())
  }
  if (tag === 'textarea' || tag === 'select') return true
  const editable = attributes.get('contenteditable')
  if (editable !== undefined && editable.trim().toLowerCase() !== 'false') return true
  return TEXT_ENTRY_ROLES.has((attributes.get('role') ?? '').trim().toLowerCase())
}

/** A frame whose document SideKick's protocol view cannot read lives in another process. */
function isOpaqueFrame(node: CdpDomNode): boolean {
  const tag = tagOf(node)
  if (tag === 'iframe' || tag === 'frame') return !node.contentDocument
  return tag === 'embed' || tag === 'object' || tag === 'portal' || tag === 'fencedframe'
}

interface Located {
  node: CdpDomNode
  /** Elements from the top of the node's own tree scope down to it. */
  path: CdpDomNode[]
  /** How the node's scope is entered from the one outside it: a shadow host or a frame. */
  outer?: Located
}

/**
 * Finds a node in a pierced document tree, with the chain of tree scopes it is in: the document,
 * shadow roots, and same-process frame documents, as `>>` separates them in its selector.
 */
export function locateNode(root: CdpDomNode, backendNodeId: number): Located | undefined {
  const visit = (
    node: CdpDomNode,
    path: CdpDomNode[],
    outer: Located | undefined
  ): Located | undefined => {
    const here = node.nodeType === ELEMENT_NODE ? [...path, node] : path
    if (node.backendNodeId === backendNodeId) return { node, path: here, outer }
    if (node.nodeType === ELEMENT_NODE) {
      for (const shadow of node.shadowRoots ?? []) {
        const found = visit(shadow, [], { node, path: here, outer })
        if (found) return found
      }
      if (node.contentDocument) {
        const found = visit(node.contentDocument, [], { node, path: here, outer })
        if (found) return found
      }
    }
    for (const child of node.children ?? []) {
      const found = visit(child, here, outer)
      if (found) return found
    }
    return undefined
  }
  return visit(root, [], undefined)
}

/** CSS.escape for identifiers, as the CSSOM specification defines it. */
export function cssEscape(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    const code = value.charCodeAt(index)
    if (code === 0) result += '\uFFFD'
    else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (index === 0 && code >= 0x30 && code <= 0x39) ||
      (index === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
    )
      result += `\\${code.toString(16)} `
    else if (index === 0 && value.length === 1 && code === 0x2d) result += `\\${char}`
    else if (code >= 0x80 || /[-_a-zA-Z0-9]/.test(char)) result += char
    else result += `\\${char}`
  }
  return result
}

function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, ' ')}"`
}

/** How many elements in one tree scope carry each value of an attribute. */
function scopeCounts(scope: CdpDomNode, attribute: string): Map<string, number> {
  const counts = new Map<string, number>()
  const walk = (node: CdpDomNode): void => {
    if (node.nodeType === ELEMENT_NODE) {
      const value = attributeMap(node).get(attribute)
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    // Shadow roots and frame documents are separate scopes.
    for (const child of node.children ?? []) walk(child)
  }
  walk(scope)
  return counts
}

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']

/** A selector step for one element within its scope, and whether it alone is unique there. */
function selectorStep(
  node: CdpDomNode,
  parent: CdpDomNode | undefined,
  counts: (attribute: string) => Map<string, number>
): { step: string; unique: boolean } {
  const tag = tagOf(node)
  const attributes = attributeMap(node)
  const id = attributes.get('id')
  if (id && id.length <= 80 && counts('id').get(id) === 1) {
    return { step: `#${cssEscape(id)}`, unique: true }
  }
  for (const name of TEST_ID_ATTRIBUTES) {
    const value = attributes.get(name)
    if (value && value.length <= 80 && counts(name).get(value) === 1) {
      return { step: `[${name}=${cssString(value)}]`, unique: true }
    }
  }
  // Classes that read like words, not hashes a build generated.
  const classes = (attributes.get('class') ?? '')
    .split(/\s+/)
    .filter(
      (name) =>
        /^[a-zA-Z_][\w-]{0,31}$/.test(name) &&
        (name.match(/\d/g)?.length ?? 0) < 3 &&
        !/^(css|sc|jsx|svelte|emotion)-/i.test(name)
    )
    .slice(0, 2)
  let step = `${cssEscape(tag)}${classes.map((name) => `.${cssEscape(name)}`).join('')}`
  const siblings = (parent?.children ?? []).filter(
    (sibling) => sibling.nodeType === ELEMENT_NODE && tagOf(sibling) === tag
  )
  if (siblings.length > 1) step += `:nth-of-type(${siblings.indexOf(node) + 1})`
  return { step, unique: false }
}

function scopeSelector(located: Located, scopeRoot: CdpDomNode): string {
  const cache = new Map<string, Map<string, number>>()
  const counts = (attribute: string): Map<string, number> => {
    let found = cache.get(attribute)
    if (!found) cache.set(attribute, (found = scopeCounts(scopeRoot, attribute)))
    return found
  }
  const steps: string[] = []
  for (let index = located.path.length - 1; index >= 0; index--) {
    const node = located.path[index]
    const tag = tagOf(node)
    if (tag === 'html') break
    // The body anchors a path that found nothing unique on the way up.
    if (tag === 'body' && steps.length) {
      steps.unshift('body')
      break
    }
    const parent = index > 0 ? located.path[index - 1] : undefined
    const { step, unique } = selectorStep(node, parent ?? scopeParent(scopeRoot, node), counts)
    steps.unshift(step)
    if (unique || steps.length >= MAX_SELECTOR_STEPS) break
  }
  return steps.join(' > ')
}

/** A shadow root's top-level elements have the root itself as their parent. */
function scopeParent(scopeRoot: CdpDomNode, node: CdpDomNode): CdpDomNode | undefined {
  return scopeRoot.children?.includes(node) ? scopeRoot : undefined
}

/** A CSS path to the node, with ` >> ` stepping into each shadow root or frame on the way. */
export function annotationSelector(root: CdpDomNode, backendNodeId: number): string | undefined {
  const located = locateNode(root, backendNodeId)
  if (!located || located.node.nodeType !== ELEMENT_NODE) return undefined
  const scopes: string[] = []
  let current: Located | undefined = located
  let scopeRoot = scopeRootOf(root, located)
  while (current) {
    scopes.unshift(scopeSelector(current, scopeRoot))
    const outer: Located | undefined = current.outer
    if (outer) scopeRoot = scopeRootOf(root, outer)
    current = outer
  }
  return scopes.filter(Boolean).join(' >> ') || undefined
}

/** The document, shadow root, or frame document whose tree holds the located node's path. */
function scopeRootOf(root: CdpDomNode, located: Located): CdpDomNode {
  const top = located.path[0]
  if (!located.outer) return root
  const host = located.outer.node
  for (const shadow of host.shadowRoots ?? []) if (contains(shadow, top)) return shadow
  return host.contentDocument ?? root
}

function contains(scope: CdpDomNode, node: CdpDomNode | undefined): boolean {
  if (!node) return false
  return (scope.children ?? []).some((child) => child === node || contains(child, node))
}

function hiddenFromText(node: CdpDomNode): boolean {
  const attributes = attributeMap(node)
  return (
    SKIPPED_TEXT_ELEMENTS.has(tagOf(node)) ||
    attributes.has('hidden') ||
    attributes.has('inert') ||
    attributes.get('aria-hidden')?.trim().toLowerCase() === 'true' ||
    isValueBearing(node)
  )
}

/**
 * The text the element shows, without what anyone typed: fields, lists, editable areas, and
 * elements the page hides are left out, and frames are not entered.
 */
export function annotationText(node: CdpDomNode): string | undefined {
  const parts: string[] = []
  let length = 0
  const walk = (current: CdpDomNode): void => {
    if (length > MAX_TEXT) return
    if (current.nodeType === TEXT_NODE) {
      const value = current.nodeValue ?? ''
      parts.push(value)
      length += value.length
      return
    }
    if (current.nodeType === ELEMENT_NODE && hiddenFromText(current)) return
    for (const shadow of current.shadowRoots ?? []) walk(shadow)
    for (const child of current.children ?? []) walk(child)
  }
  if (node.nodeType === ELEMENT_NODE && isValueBearing(node)) return undefined
  walk(node)
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** Whether a value-bearing element sits inside this one, so a name made of its content may hold its value. */
function holdsValueBearing(node: CdpDomNode): boolean {
  const walk = (current: CdpDomNode): boolean =>
    [...(current.shadowRoots ?? []), ...(current.children ?? [])].some(
      (child) => isValueBearing(child) || walk(child)
    )
  return walk(node)
}

/**
 * Every place in the document a typed or chosen value could show, and every frame SideKick
 * cannot read into: the picture covers these.
 */
export function annotationMaskNodes(root: CdpDomNode): number[] {
  const found: number[] = []
  const walk = (node: CdpDomNode): void => {
    if (found.length >= MAX_MASKS) return
    if (node.nodeType === ELEMENT_NODE && (isValueBearing(node) || isOpaqueFrame(node))) {
      found.push(node.backendNodeId)
      return
    }
    for (const shadow of node.shadowRoots ?? []) walk(shadow)
    if (node.contentDocument) walk(node.contentDocument)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return found
}

function quadBox(quad: number[] | undefined): BrowserAnnotationBox | undefined {
  if (!quad || quad.length < 8 || !quad.every(Number.isFinite)) return undefined
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** The element's border box in the viewport's CSS pixels, if it is laid out. */
export async function annotationNodeBox(
  send: BrowserAnnotationCdp,
  backendNodeId: number
): Promise<BrowserAnnotationBox | undefined> {
  const response = await send<{ model?: { border?: number[] } }>('DOM.getBoxModel', {
    backendNodeId
  }).catch(() => undefined)
  return quadBox(response?.model?.border)
}

export async function annotationViewport(
  send: BrowserAnnotationCdp
): Promise<BrowserAnnotationViewport> {
  const metrics = await send<{
    cssLayoutViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
    cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
    /** In device pixels. */
    visualViewport?: { clientWidth: number }
  }>('Page.getLayoutMetrics')
  const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
  if (!viewport || !(viewport.clientWidth > 0) || !(viewport.clientHeight > 0)) {
    throw new Error('The page has no viewport to mark')
  }
  return {
    width: viewport.clientWidth,
    height: viewport.clientHeight,
    pageX: Number.isFinite(viewport.pageX) ? viewport.pageX : 0,
    pageY: Number.isFinite(viewport.pageY) ? viewport.pageY : 0,
    ...(metrics.visualViewport?.clientWidth && metrics.visualViewport.clientWidth > 0
      ? { devicePixelRatio: metrics.visualViewport.clientWidth / viewport.clientWidth }
      : {})
  }
}

/** What the pointer is over, in the words a mark is named with: "Image", "Link". */
function hoverLabel(node: CdpDomNode): string {
  return browserMarkKind(undefined, tagOf(node))
}

/**
 * The element a click at a viewport point would reach. An element the page makes transparent
 * to the mouse, such as an invisible layer over everything, is passed through as a click is.
 */
export async function annotationHitTest(
  send: BrowserAnnotationCdp,
  x: number,
  y: number
): Promise<BrowserAnnotationHit | undefined> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined
  const hit = await send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
    x: Math.floor(x),
    y: Math.floor(y),
    includeUserAgentShadowDOM: false,
    ignorePointerEventsNone: false
  }).catch(() => undefined)
  if (!hit?.backendNodeId) return undefined
  const described = await send<{ node?: CdpDomNode }>('DOM.describeNode', {
    backendNodeId: hit.backendNodeId,
    depth: 0
  }).catch(() => undefined)
  const node = described?.node
  if (!node || node.nodeType !== ELEMENT_NODE) return undefined
  const box = await annotationNodeBox(send, hit.backendNodeId)
  if (!box) return undefined
  return { backendNodeId: hit.backendNodeId, box, label: hoverLabel(node), tag: tagOf(node) }
}

interface AxNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: unknown }
  name?: { value?: unknown }
}

/** What Chromium's accessibility tree calls the element: its role and name, never its value. */
async function accessibleIdentity(
  send: BrowserAnnotationCdp,
  backendNodeId: number
): Promise<{ role?: string; name?: string }> {
  const response = await send<{ nodes?: AxNode[] }>('Accessibility.getPartialAXTree', {
    backendNodeId,
    fetchRelatives: false
  }).catch(() => undefined)
  const node =
    response?.nodes?.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ??
    response?.nodes?.[0]
  if (!node || node.ignored) return {}
  const role = typeof node.role?.value === 'string' ? node.role.value : undefined
  const name = typeof node.name?.value === 'string' ? node.name.value.trim() : undefined
  return {
    ...(role && !QUIET_ROLES.has(role) ? { role } : {}),
    ...(name ? { name: name.length > 300 ? `${name.slice(0, 299)}…` : name } : {})
  }
}

export interface BrowserAnnotationDocument {
  root: CdpDomNode
}

/** The whole document, through shadow roots and same-process frames, as Chromium holds it. */
export async function annotationDocument(
  send: BrowserAnnotationCdp
): Promise<BrowserAnnotationDocument> {
  const document = await send<{ root?: CdpDomNode }>('DOM.getDocument', {
    depth: -1,
    pierce: true
  })
  if (!document.root) throw new Error('The page has no document to mark')
  return { root: document.root }
}

export async function describeAnnotationElement(
  send: BrowserAnnotationCdp,
  document: BrowserAnnotationDocument,
  backendNodeId: number
): Promise<BrowserAnnotationElement | undefined> {
  const located = locateNode(document.root, backendNodeId)
  if (!located || located.node.nodeType !== ELEMENT_NODE) return undefined
  const node = located.node
  const identity = await accessibleIdentity(send, backendNodeId)
  // A name made from an element's content can include a field's value; the page's own label
  // for the element is used instead.
  const name =
    identity.name && holdsValueBearing(node)
      ? attributeMap(node).get('aria-label')?.trim().slice(0, 300) || undefined
      : identity.name
  const text = annotationText(node)
  return {
    selector: annotationSelector(document.root, backendNodeId) ?? tagOf(node),
    tag: tagOf(node),
    ...(identity.role ? { role: identity.role } : {}),
    ...(name ? { accessibleName: name } : {}),
    ...(text && text !== name ? { text } : {})
  }
}

/** The boxes, in viewport CSS pixels, of the places the picture covers. */
export async function annotationMaskBoxes(
  send: BrowserAnnotationCdp,
  document: BrowserAnnotationDocument,
  within: BrowserAnnotationBox
): Promise<BrowserAnnotationBox[]> {
  const boxes = await Promise.all(
    annotationMaskNodes(document.root).map((id) => annotationNodeBox(send, id))
  )
  return boxes.filter(
    (box): box is BrowserAnnotationBox => Boolean(box) && intersects(box!, within)
  )
}

export function intersects(a: BrowserAnnotationBox, b: BrowserAnnotationBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function clampBox(
  box: BrowserAnnotationBox,
  width: number,
  height: number
): BrowserAnnotationBox | undefined {
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const right = Math.min(width, box.x + box.width)
  const bottom = Math.min(height, box.y + box.height)
  if (right - x < 1 || bottom - y < 1) return undefined
  return { x, y, width: right - x, height: bottom - y }
}

/** Space around a mark in its picture, so the agent sees what is next to it. */
export const ANNOTATION_CROP_PADDING = 24

export interface AnnotationBitmap {
  /** Four bytes a pixel, in either channel order: only greys are written. */
  data: Buffer
  width: number
  height: number
}

function pixelRect(
  box: BrowserAnnotationBox,
  scale: number,
  bitmap: AnnotationBitmap
): { left: number; top: number; right: number; bottom: number } | undefined {
  const left = Math.max(0, Math.floor(box.x * scale))
  const top = Math.max(0, Math.floor(box.y * scale))
  const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * scale))
  const bottom = Math.min(bitmap.height, Math.ceil((box.y + box.height) * scale))
  return right > left && bottom > top ? { left, top, right, bottom } : undefined
}

function setGrey(bitmap: AnnotationBitmap, x: number, y: number, value: number): void {
  const offset = (y * bitmap.width + x) * 4
  bitmap.data[offset] = value
  bitmap.data[offset + 1] = value
  bitmap.data[offset + 2] = value
  bitmap.data[offset + 3] = 255
}

/** Covers a box with grey stripes, which read as "hidden" rather than as an empty field. */
export function coverBox(bitmap: AnnotationBitmap, box: BrowserAnnotationBox, scale: number): void {
  const rect = pixelRect(box, scale, bitmap)
  if (!rect) return
  for (let y = rect.top; y < rect.bottom; y++) {
    for (let x = rect.left; x < rect.right; x++) {
      setGrey(bitmap, x, y, (x + y) % 12 < 6 ? 0x8c : 0xa6)
    }
  }
}

/** Outlines the mark in alternating black and white, visible on any background. */
export function outlineBox(
  bitmap: AnnotationBitmap,
  box: BrowserAnnotationBox,
  scale: number
): void {
  const rect = pixelRect(box, scale, bitmap)
  if (!rect) return
  const thickness = Math.max(2, Math.round(2 * scale))
  const dash = (position: number): number => (Math.floor(position / (4 * scale)) % 2 ? 0xff : 0)
  for (let x = rect.left; x < rect.right; x++) {
    for (let t = 0; t < thickness; t++) {
      if (rect.top + t < bitmap.height) setGrey(bitmap, x, rect.top + t, dash(x))
      if (rect.bottom - 1 - t >= 0) setGrey(bitmap, x, rect.bottom - 1 - t, dash(x))
    }
  }
  for (let y = rect.top; y < rect.bottom; y++) {
    for (let t = 0; t < thickness; t++) {
      if (rect.left + t < bitmap.width) setGrey(bitmap, rect.left + t, y, dash(y))
      if (rect.right - 1 - t >= 0) setGrey(bitmap, rect.right - 1 - t, y, dash(y))
    }
  }
}

/** The part of the viewport a mark's picture shows, in viewport CSS pixels. */
export function annotationCropBox(
  mark: BrowserAnnotationBox,
  viewport: { width: number; height: number }
): BrowserAnnotationBox | undefined {
  return clampBox(
    {
      x: mark.x - ANNOTATION_CROP_PADDING,
      y: mark.y - ANNOTATION_CROP_PADDING,
      width: mark.width + ANNOTATION_CROP_PADDING * 2,
      height: mark.height + ANNOTATION_CROP_PADDING * 2
    },
    viewport.width,
    viewport.height
  )
}

/** The longest side of a mark's picture; the agent needs the detail, not a whole screen. */
const MAX_CROP_SIDE = 1_280
/** Text stays readable at twice the CSS size, as on a high-density screen. */
const MAX_CROP_SCALE = 2

export interface BrowserAnnotationPicture {
  mimeType: 'image/png' | 'image/jpeg'
  dataUrl: string
  width: number
  height: number
  mark: BrowserAnnotationBox
}

/**
 * Takes the picture of a mark as Chromium draws the page: just the part around the mark, in CSS
 * pixels of the page, so the boxes in `masks` land exactly where they are. Every one is covered
 * before the picture leaves this function, and the mark is outlined.
 */
export async function captureAnnotationPicture(
  send: BrowserAnnotationCdp,
  viewport: BrowserAnnotationViewport,
  mark: BrowserAnnotationBox,
  masks: BrowserAnnotationBox[],
  maxBytes: number
): Promise<BrowserAnnotationPicture | undefined> {
  const visible = clampBox(mark, viewport.width, viewport.height)
  const crop = visible && annotationCropBox(visible, viewport)
  if (!visible || !crop) return undefined
  const target = Math.min(MAX_CROP_SCALE, MAX_CROP_SIDE / Math.max(crop.width, crop.height))
  const ratio = viewport.devicePixelRatio
  let scale = ratio && Number.isFinite(ratio) && ratio > 0 ? target / ratio : target
  for (let attempt = 0; attempt < 4; attempt++, scale *= 0.7) {
    // A clip is placed in the document, so the viewport's scroll position is added.
    const shot = await send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: crop.x + viewport.pageX,
        y: crop.y + viewport.pageY,
        width: crop.width,
        height: crop.height,
        scale
      }
    })
    if (!shot.data) return undefined
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
    const size = image.getSize()
    if (!size.width || !size.height) return undefined
    const pixels = size.width / crop.width
    const local = (box: BrowserAnnotationBox): BrowserAnnotationBox => ({
      ...box,
      x: box.x - crop.x,
      y: box.y - crop.y
    })
    const bitmap: AnnotationBitmap = {
      data: image.toBitmap(),
      width: size.width,
      height: size.height
    }
    for (const box of masks) coverBox(bitmap, local(box), pixels)
    const outlined = local(visible)
    outlineBox(bitmap, outlined, pixels)
    const covered = nativeImage.createFromBitmap(bitmap.data, size)
    const png = covered.toPNG()
    // Text stays crisp as PNG; a photo-like crop is far smaller as JPEG.
    const encoded =
      png.byteLength <= maxBytes / 2
        ? { mimeType: 'image/png' as const, bytes: png }
        : { mimeType: 'image/jpeg' as const, bytes: covered.toJPEG(82) }
    if (encoded.bytes.byteLength > maxBytes) continue
    const shown = clampBox(
      {
        x: Math.round(outlined.x * pixels),
        y: Math.round(outlined.y * pixels),
        width: Math.round(outlined.width * pixels),
        height: Math.round(outlined.height * pixels)
      },
      size.width,
      size.height
    )
    return {
      mimeType: encoded.mimeType,
      dataUrl: `data:${encoded.mimeType};base64,${encoded.bytes.toString('base64')}`,
      width: size.width,
      height: size.height,
      mark: shown ?? { x: 0, y: 0, width: size.width, height: size.height }
    }
  }
  return undefined
}
