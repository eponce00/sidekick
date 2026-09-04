import { createHash, randomUUID } from 'crypto'
import { promises as fs, realpathSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import type {
  BrowserWindow as ElectronBrowserWindow,
  KeyboardInputEvent,
  MouseInputEvent,
  MouseWheelInputEvent,
  WebContents
} from 'electron'
import {
  browserPdfUrlAllowed,
  browserPdfViewerUrl,
  createBrowserPdfSession,
  getBrowserPdfSession,
  revokeBrowserPdfSession,
  revokeBrowserPdfSessionsByOwner
} from '../bootstrap/browserPdfSessionRegistry'

export interface BrowserViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface BrowserOperationOptions {
  signal?: AbortSignal
  /** Absolute Unix time in milliseconds. */
  deadlineAt?: number
  /** Relative timeout. The earliest of timeoutMs and deadlineAt wins. */
  timeoutMs?: number
}

export interface BrowserTarget {
  /** A current ref returned in BrowserObservation.semanticSnapshot. */
  ref?: string
  /** Accessible role/name lookup. Ambiguous lookups fail unless nth is supplied. */
  role?: string
  name?: string
  /** CSS fallback after ref/role-name lookup and before coordinates. Must resolve uniquely unless nth is set. */
  selector?: string
  exact?: boolean
  nth?: number
  /** Internal action-specific ranking when a visible name matches multiple AX roles. */
  preferredRoles?: string[]
  /** Viewport screenshot that the coordinate fallback was read from. */
  screenshotId?: string
  /** Screenshot-pixel fallback used only when no semantic target resolves. */
  coordinates?: { x: number; y: number }
}

export interface BrowserOpenInput {
  runId: string
  url?: string
  viewport?: BrowserViewport
  /** Host-approved roots for this session's file:// inspection. */
  allowedFileRoots?: string[]
  /** Only IDs approved through allowedAttachWebContentsIds/canAttachWebContents may attach. */
  attachWebContentsId?: number
}

export interface BrowserObservationOptions {
  tabId?: string
  screenshot?: BrowserScreenshotKind | 'none'
  includeSemanticSnapshot?: boolean
  semanticDepth?: number
}

export type BrowserScreenshotKind = 'viewport' | 'fullPage' | 'element'

export interface BrowserScreenshotArtifact {
  id: string
  sessionId: string
  tabId: string
  path: string
  /** Renderer-safe URL served by SideKick's locked-down browser-artifact protocol. */
  url: string
  mimeType: 'image/png'
  kind: BrowserScreenshotKind
  sourceUrl: string
  width: number
  height: number
  bytes: number
  sha256: string
  createdAt: number
  changed: boolean | null
  unchangedStreak: number
}

export interface BrowserConsoleEntry {
  sequence: number
  tabId: string
  timestamp: number
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  lineNumber?: number
  sourceId?: string
}

export interface BrowserPointer {
  x: number
  y: number
  action: 'click' | 'hold' | 'type' | 'select' | 'press' | 'scroll' | 'hover'
  targetMode: BrowserActionResult['targetMode']
  updatedAt: number
}

export interface BrowserHumanVerification {
  required: true
  kind: 'captcha_or_bot_challenge'
  message: string
  detectedBy: 'accessibility' | 'page_title' | 'dom_marker'
}

export interface BrowserNetworkFailure {
  sequence: number
  tabId: string
  timestamp: number
  url: string
  method?: string
  resourceType?: string
  errorText: string
  canceled: boolean
}

export interface BrowserTabSummary {
  id: string
  webContentsId: number
  title: string
  url: string
  active: boolean
  loading: boolean
  attached: boolean
}

export interface BrowserObservation {
  sessionId: string
  runId: string
  observedAt: number
  tab: BrowserTabSummary
  tabs: BrowserTabSummary[]
  viewport: BrowserViewport
  /** Last resolved interaction point in viewport CSS pixels, for the visible activity inspector. */
  pointer?: BrowserPointer | null
  semanticSnapshot?: string
  semanticNodeCount?: number
  /** A site-owned anti-bot checkpoint that requires same-session human takeover. */
  humanVerification?: BrowserHumanVerification | null
  screenshot?: BrowserScreenshotArtifact
  screenshotChanged: boolean | null
  unchangedScreenshotStreak: number
  console: BrowserConsoleEntry[]
  failedRequests: BrowserNetworkFailure[]
  cursors: { console: number; network: number }
}

export interface BrowserQuiescenceResult {
  idle: boolean
  waitedMs: number
  pendingRequests: number
  mutationRevision: number
  timedOut: boolean
}

export interface BrowserActionResult {
  sessionId: string
  tabId: string
  action: string
  targetMode: 'ref' | 'semantic' | 'selector' | 'coordinates' | 'page'
  coordinateFallbackUsed: boolean
  durationMs: number
  quiescence: BrowserQuiescenceResult
  loopProtection: {
    unchangedRepeatCount: number
    blockedOnNextIdenticalAction: boolean
  }
  effect?: {
    changed: boolean
    kind: 'scroll'
    before: { x: number; y: number }
    after: { x: number; y: number }
    message?: string
  }
  observation: BrowserObservation
}

export interface BrowserScreenshotInput {
  sessionId: string
  tabId?: string
  kind?: BrowserScreenshotKind
  target?: BrowserTarget
}

export interface BrowserNavigateInput {
  sessionId: string
  tabId?: string
  /** Defaults to url when url is supplied. */
  action?: 'url' | 'back' | 'forward' | 'reload'
  url?: string
}

export interface BrowserClickInput {
  sessionId: string
  tabId?: string
  target: BrowserTarget
  button?: 'left' | 'middle' | 'right'
  clickCount?: 1 | 2 | 3
}

export interface BrowserHoldInput {
  sessionId: string
  tabId?: string
  target: BrowserTarget
  button?: 'left' | 'middle' | 'right'
  /** Bounded duration for ordinary press-and-hold UI controls. */
  durationMs: number
}

export interface BrowserTypeInput {
  sessionId: string
  tabId?: string
  target: BrowserTarget
  text: string
  clear?: boolean
  submit?: boolean
}

export interface BrowserSelectInput {
  sessionId: string
  tabId?: string
  target: BrowserTarget
  values: string[]
}

export type BrowserFormFieldInput =
  | { kind: 'textbox'; target: BrowserTarget; value: string }
  | { kind: 'select'; target: BrowserTarget; values: string[] }
  | { kind: 'checkbox'; target: BrowserTarget; checked: boolean }
  | { kind: 'radio'; target: BrowserTarget; checked: true }

export interface BrowserFillFormInput {
  sessionId: string
  tabId?: string
  /** Ordered fields. Execution stops at the first failed or page-changing field. */
  fields: BrowserFormFieldInput[]
}

export interface BrowserFormFieldResult {
  index: number
  kind: BrowserFormFieldInput['kind']
  status: 'filled' | 'unchanged' | 'failed' | 'skipped'
  targetMode?: Exclude<BrowserActionResult['targetMode'], 'coordinates' | 'page'>
  verification?: {
    passed: boolean
    valueLength?: number
    selectedCount?: number
  }
  error?: {
    code: 'target_not_found' | 'unsupported_control' | 'verification_failed' | 'page_changed'
    message: string
  }
}

export interface BrowserFillFormResult {
  sessionId: string
  tabId: string
  action: 'fill_form'
  completed: boolean
  stopReason: 'completed' | 'field_failed' | 'page_changed'
  attemptedFields: number
  filledFields: number
  durationMs: number
  quiescence: BrowserQuiescenceResult
  loopProtection: BrowserActionResult['loopProtection']
  /** Contains verification metadata only; requested and actual values are never returned. */
  fields: BrowserFormFieldResult[]
  observation: BrowserObservation
}

export interface BrowserPressInput {
  sessionId: string
  tabId?: string
  target?: BrowserTarget
  key: string
}

export interface BrowserScrollInput {
  sessionId: string
  tabId?: string
  target?: BrowserTarget
  deltaX?: number
  deltaY: number
}

export interface BrowserResizeInput {
  sessionId: string
  tabId?: string
  viewport: BrowserViewport
}

export interface BrowserHoverInput {
  sessionId: string
  tabId?: string
  target: BrowserTarget
}

export type BrowserWaitCondition =
  | { type: 'quiescence'; idleMs?: number; maxWaitMs?: number }
  | { type: 'time'; ms: number }
  | { type: 'text'; text: string; state?: 'present' | 'absent' }
  | { type: 'url'; value: string; match?: 'equals' | 'contains' | 'regex' }
  | { type: 'semantic'; target: BrowserTarget; state?: 'present' | 'absent' }

export interface BrowserWaitInput {
  sessionId: string
  tabId?: string
  condition?: BrowserWaitCondition
}

export interface BrowserTabsInput {
  sessionId: string
  action?: 'list' | 'new' | 'select' | 'close'
  tabId?: string
  url?: string
}

export interface BrowserTabsResult {
  sessionId: string
  activeTabId: string
  tabs: BrowserTabSummary[]
  observation?: BrowserObservation
}

export interface BrowserTelemetryInput {
  sessionId: string
  tabId?: string
  afterSequence?: number
}

export interface BrowserEvaluateInput {
  sessionId: string
  tabId?: string
  expression: string
}

export interface BrowserEvaluateResult {
  sessionId: string
  tabId: string
  value: unknown
  serializedBytes: number
  truncated: boolean
}

export type BrowserVerificationAssertion =
  | { type: 'url'; value: string; match?: 'equals' | 'contains' | 'regex' }
  | { type: 'title'; value: string; match?: 'equals' | 'contains' | 'regex' }
  | { type: 'text'; text: string; state?: 'present' | 'absent' }
  | { type: 'semantic'; target: BrowserTarget; state?: 'present' | 'absent' }
  | { type: 'screenshotChanged'; baselineSha256: string; changed?: boolean }

export interface BrowserVerifyInput {
  sessionId: string
  tabId?: string
  assertions: BrowserVerificationAssertion[]
}

export interface BrowserVerificationResult {
  passed: boolean
  assertions: Array<BrowserVerificationAssertion & { passed: boolean; actual?: string }>
  observation: BrowserObservation
}

export interface BrowserCloseInput {
  sessionId?: string
  runId?: string
  tabId?: string
  deleteArtifacts?: boolean
}

export interface BrowserHumanTakeoverResult {
  active: boolean
  observation: BrowserObservation
}

export interface NativeBrowserSessionServiceOptions {
  artifactRoot: string
  allowedFileRoots?: string[]
  allowedAttachWebContentsIds?: ReadonlySet<number>
  canAttachWebContents?: (webContentsId: number, currentUrl: string) => boolean
  maxSessionsPerRun?: number
  maxTotalSessions?: number
  maxTabsPerSession?: number
  maxArtifacts?: number
  maxArtifactBytes?: number
  artifactRetentionMs?: number
  maxTelemetryEntries?: number
  maxRepeatedNoChangeActions?: number
  defaultViewport?: BrowserViewport
  now?: () => number
  runtime?: NativeBrowserRuntime
}

export interface NativeBrowserSurfaceConsoleMessage {
  level: BrowserConsoleEntry['level']
  message: string
  lineNumber?: number
  sourceId?: string
}

export interface NativeBrowserSurfaceLoadFailure {
  url: string
  errorText: string
  canceled?: boolean
}

export interface NativeBrowserSurfaceCapture {
  png: Buffer
  width: number
  height: number
}

export interface NativeBrowserSurface {
  readonly webContentsId: number
  readonly attached: boolean
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  isLoading(): boolean
  loadURL(url: string): Promise<void>
  stop(): void
  close(): Promise<void>
  showForHumanTakeover(): void
  hideHumanTakeover(): void
  isHumanTakeoverVisible(): boolean
  focus(): void
  insertText(text: string): Promise<void>
  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void
  resizeViewport(viewport: BrowserViewport): void
  executeJavaScript<T>(source: string): Promise<T>
  captureViewport(): Promise<NativeBrowserSurfaceCapture>
  attachDebugger(): Promise<void>
  detachDebugger(): void
  sendDebuggerCommand<T>(method: string, params?: Record<string, unknown>): Promise<T>
  setNavigationGuard(guard: (url: string) => boolean): void
  /** Guards file:// document and subresource requests in the isolated partition. */
  setRequestGuard(guard: (url: string) => boolean): void
  onConsole(listener: (message: NativeBrowserSurfaceConsoleMessage) => void): () => void
  onLoadFailure(listener: (failure: NativeBrowserSurfaceLoadFailure) => void): () => void
  onDebuggerMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void
  onDestroyed(listener: () => void): () => void
  onOpenUrl(listener: (url: string) => void): () => void
}

export interface NativeBrowserRuntime {
  createSurface(options: {
    partition: string
    viewport: BrowserViewport
  }): Promise<NativeBrowserSurface>
  attachSurface(webContentsId: number): Promise<NativeBrowserSurface>
}

interface CDPAXValue {
  value?: unknown
}

interface CDPAXProperty {
  name: string
  value?: CDPAXValue
}

interface CDPAXNode {
  nodeId: string
  ignored?: boolean
  role?: CDPAXValue
  name?: CDPAXValue
  description?: CDPAXValue
  value?: CDPAXValue
  properties?: CDPAXProperty[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

interface SemanticRef {
  ref: string
  backendNodeId: number
  role: string
  name: string
  epoch: number
}

interface ActionRecord {
  fingerprint: string
  changed: boolean
}

interface RequestMetadata {
  url: string
  method?: string
  resourceType?: string
  ignoredForIdle: boolean
  startedAt: number
}

interface CoordinateCaptureState {
  sourceUrl: string
  refEpoch: number
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  mutationRevision: number
}

interface TabState {
  id: string
  surface: NativeBrowserSurface
  /** User-facing source URL when the WebContents is showing an internal viewer. */
  logicalUrl?: string
  pdfSessionToken?: string
  pdfSessionTokens: Set<string>
  refEpoch: number
  refs: Map<string, SemanticRef>
  semanticNodes: SemanticRef[]
  consoleCursor: number
  networkCursor: number
  lastPointer?: BrowserPointer
  lastViewportScreenshot?: {
    id: string
    imageWidth: number
    imageHeight: number
  } & CoordinateCaptureState
  lastScreenshotHashes: Partial<Record<BrowserScreenshotKind, string>>
  unchangedScreenshotStreaks: Partial<Record<BrowserScreenshotKind, number>>
  inFlight: Map<string, RequestMetadata>
  actionHistory: ActionRecord[]
  disposers: Array<() => void>
}

interface SessionState {
  id: string
  runId: string
  partition: string
  allowedFileRoots: string[]
  tabs: Map<string, TabState>
  activeTabId: string
  humanTakeoverTabId?: string
  console: BrowserConsoleEntry[]
  failures: BrowserNetworkFailure[]
  consoleSequence: number
  networkSequence: number
  tail: Promise<void>
  createdAt: number
}

interface ElementPoint {
  x: number
  y: number
  backendNodeId?: number
  mode: BrowserActionResult['targetMode']
  fallbackUsed: boolean
}

interface BrowserFormControlState {
  kind: 'textbox' | 'select' | 'checkbox' | 'radio' | 'unsupported'
  disabled: boolean
  readOnly: boolean
  value?: string
  selectedValues?: string[]
  checked?: boolean
}

interface BrowserSelectMutationResult {
  changed: boolean
  expectedValues: string[]
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 800, deviceScaleFactor: 1 }
const DEFAULT_MAX_SESSIONS_PER_RUN = 2
const DEFAULT_MAX_TOTAL_SESSIONS = 6
const DEFAULT_MAX_TABS = 8
const DEFAULT_MAX_ARTIFACTS = 200
const DEFAULT_MAX_ARTIFACT_BYTES = 250 * 1024 * 1024
const DEFAULT_MAX_ARTIFACTS_PER_SESSION = 50
const DEFAULT_MAX_ARTIFACT_BYTES_PER_SESSION = 64 * 1024 * 1024
const DEFAULT_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_TELEMETRY = 2_000
const DEFAULT_MAX_REPEATED_NO_CHANGE = 3
const MAX_SEMANTIC_NODES = 800
const MAX_SEMANTIC_CHARS = 96 * 1024
const MAX_EVALUATION_BYTES = 64 * 1024
const MAX_MODEL_SCREENSHOT_BYTES = 8 * 1024 * 1024
const MAX_SCREENSHOT_DIMENSION = 16_384
const MAX_SCREENSHOT_PIXELS = 40_000_000
const MIN_HOLD_MS = 100
const MAX_HOLD_MS = 10_000

const HUMAN_VERIFICATION_PATTERNS: readonly RegExp[] = [
  /\bpress\s*(?:&|and)\s*hold\b[\s\S]{0,160}\b(?:human|verify|verification)\b/i,
  /\b(?:verify|confirm)\s+(?:that\s+)?(?:you(?:'re|\s+are)|yourself)\s+(?:a\s+)?human\b/i,
  /\bi(?:'m|\s+am)\s+not\s+a\s+robot\b/i,
  /\b(?:solve|complete|enter)\b[^\n]{0,40}\bcaptcha\b/i,
  /\bcomplete\s+(?:the\s+)?security\s+check\b/i
]

const HUMAN_VERIFICATION_TITLE_PATTERNS: readonly RegExp[] = [
  /\bcaptcha\b/i,
  /\bsecurity\s+check\b/i,
  /\b(?:verify|confirm)\b[\s\S]{0,80}\bhuman\b/i
]

class BrowserHumanVerificationError extends Error {
  constructor() {
    super(
      'Human verification required. Keep this browser session open and call browser_request_human so the user can take over safely.'
    )
    this.name = 'BrowserHumanVerificationError'
  }
}

function detectTextualHumanVerification(
  title: string,
  text: string | undefined,
  solvedKnownWidget = false
): BrowserHumanVerification | null {
  // Checked accessibility nodes and completed provider widgets can remain in
  // the DOM after a successful challenge. Do not keep a run suspended merely
  // because their static label still says CAPTCHA or "I'm not a robot."
  let activeText = text
    ?.split(/\r?\n/)
    .filter((line) => !/(?:aria-checked|checked)=(?:true|"true")/i.test(line))
    .join('\n')
  if (solvedKnownWidget) {
    activeText = activeText
      ?.split(/\r?\n/)
      .filter((line) => !/\bnot\s+a\s+robot\b/i.test(line))
      .join('\n')
  }
  if (activeText && HUMAN_VERIFICATION_PATTERNS.some((pattern) => pattern.test(activeText))) {
    return {
      required: true,
      kind: 'captcha_or_bot_challenge',
      message:
        'This site requires a human verification step before browser automation can continue.',
      detectedBy: 'accessibility'
    }
  }
  if (
    !solvedKnownWidget &&
    HUMAN_VERIFICATION_TITLE_PATTERNS.some((pattern) => pattern.test(title))
  ) {
    return {
      required: true,
      kind: 'captcha_or_bot_challenge',
      message:
        'This site requires a human verification step before browser automation can continue.',
      detectedBy: 'page_title'
    }
  }
  return null
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function timeoutError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function currentSignal(
  options: BrowserOperationOptions,
  now: () => number
): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (options.signal) signals.push(options.signal)
  const relativeDeadline = options.timeoutMs === undefined ? Infinity : now() + options.timeoutMs
  const absoluteDeadline = options.deadlineAt ?? Infinity
  const deadline = Math.min(relativeDeadline, absoluteDeadline)
  if (Number.isFinite(deadline)) {
    const remaining = Math.max(0, deadline - now())
    if (remaining === 0) {
      const controller = new AbortController()
      controller.abort(timeoutError('Browser operation timed out'))
      signals.push(controller.signal)
    } else {
      signals.push(AbortSignal.timeout(Math.min(2_147_483_647, Math.ceil(remaining))))
    }
  }
  if (!signals.length) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    if (signal.reason?.name === 'TimeoutError') throw timeoutError('Browser operation timed out')
    throw abortError('Browser operation cancelled')
  }
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      if (signal.reason?.name === 'TimeoutError')
        reject(timeoutError('Browser operation timed out'))
      else reject(abortError('Browser operation cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await abortable(
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms))),
    signal
  )
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
  return normalized || 'unknown'
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

function valueOf(value: CDPAXValue | undefined): string {
  if (value?.value === undefined || value.value === null) return ''
  return String(value.value).replace(/\s+/g, ' ').trim()
}

function quoteSnapshot(value: string): string {
  return JSON.stringify(value.length > 300 ? `${value.slice(0, 297)}...` : value)
}

function matchesText(actual: string, expected: string, mode = 'equals'): boolean {
  if (mode === 'contains') return actual.includes(expected)
  if (mode === 'regex') {
    try {
      return new RegExp(expected).test(actual)
    } catch {
      throw new Error('Invalid verification regular expression')
    }
  }
  return actual === expected
}

function canonicalFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function redactFormObservation(
  observation: BrowserObservation,
  sensitiveStrings: ReadonlySet<string>
): BrowserObservation {
  const variants = [...sensitiveStrings]
    .filter(Boolean)
    .flatMap((value) => [value, encodeURIComponent(value)])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length)
  const redact = (text: string): string => {
    let result = text
    for (const value of variants) result = result.split(value).join('[redacted]')
    return result
  }
  let semanticSnapshot = observation.semanticSnapshot
  if (semanticSnapshot) {
    semanticSnapshot = semanticSnapshot.replace(
      /\s(value|checked|selected)=("(?:\\.|[^"])*"|[^\s\]]+)/g,
      ' $1=[redacted]'
    )
    semanticSnapshot = redact(semanticSnapshot)
  }
  return {
    ...observation,
    tab: {
      ...observation.tab,
      title: redact(observation.tab.title),
      url: redact(observation.tab.url)
    },
    tabs: observation.tabs.map((tab) => ({
      ...tab,
      title: redact(tab.title),
      url: redact(tab.url)
    })),
    ...(semanticSnapshot === undefined ? {} : { semanticSnapshot }),
    screenshot: undefined,
    screenshotChanged: null,
    console: observation.console.map((entry) => ({
      ...entry,
      message: redact(entry.message),
      ...(entry.sourceId ? { sourceId: redact(entry.sourceId) } : {})
    })),
    failedRequests: observation.failedRequests.map((failure) => ({
      ...failure,
      url: redact(failure.url),
      errorText: redact(failure.errorText)
    }))
  }
}

function finiteCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a non-negative number`)
  return value
}

function isTransientViewportCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === 'UnknownVizError'
}

class ElectronNativeBrowserSurface implements NativeBrowserSurface {
  readonly webContentsId: number
  private readonly consoleListeners = new Set<
    (message: NativeBrowserSurfaceConsoleMessage) => void
  >()
  private readonly failureListeners = new Set<(failure: NativeBrowserSurfaceLoadFailure) => void>()
  private readonly debuggerListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >()
  private readonly destroyedListeners = new Set<() => void>()
  private readonly openUrlListeners = new Set<(url: string) => void>()
  private navigationGuard: (url: string) => boolean = (url) => url === 'about:blank'
  private debuggerOwned = false
  private closing = false
  private humanTakeoverVisible = false

  constructor(
    private readonly contents: WebContents,
    private readonly ownerWindow: ElectronBrowserWindow | null,
    readonly attached: boolean
  ) {
    this.webContentsId = contents.id
    ownerWindow?.on('close', (event) => {
      if (this.closing || !this.humanTakeoverVisible) return
      // Closing the takeover window returns control to SideKick without
      // destroying the isolated tab, cookies, form state, or browser history.
      event.preventDefault()
      this.hideHumanTakeover()
    })
    ownerWindow?.on('page-title-updated', (event) => {
      if (!this.humanTakeoverVisible) return
      event.preventDefault()
      this.updateTakeoverTitle()
    })
    contents.on('did-navigate', () => this.updateTakeoverTitle())
    contents.on('did-navigate-in-page', () => this.updateTakeoverTitle())
    contents.setWindowOpenHandler(({ url }) => {
      if (this.navigationGuard(url)) {
        for (const listener of this.openUrlListeners) listener(url)
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (details, deprecatedUrl) => {
      const url = (details as unknown as { url?: string }).url ?? deprecatedUrl
      if (!this.navigationGuard(url)) details.preventDefault()
    })
    contents.on('will-redirect', (details, deprecatedUrl) => {
      const url = (details as unknown as { url?: string }).url ?? deprecatedUrl
      if (!this.navigationGuard(url)) details.preventDefault()
    })
    contents.on('console-message', (details) => {
      const modern = details as unknown as {
        level: NativeBrowserSurfaceConsoleMessage['level']
        message: string
        lineNumber: number
        sourceId: string
      }
      const normalized: NativeBrowserSurfaceConsoleMessage = {
        level: modern.level,
        message: modern.message,
        lineNumber: modern.lineNumber,
        sourceId: modern.sourceId
      }
      for (const listener of this.consoleListeners) listener(normalized)
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame && code === -3) return
      const failure = { url, errorText: description, canceled: code === -3 }
      for (const listener of this.failureListeners) listener(failure)
    })
    contents.debugger.on('message', (_event, method, params) => {
      for (const listener of this.debuggerListeners) {
        listener(method, (params ?? {}) as Record<string, unknown>)
      }
    })
    contents.once('destroyed', () => {
      for (const listener of this.destroyedListeners) listener()
      this.clearListeners()
    })
  }

  getURL(): string {
    return this.contents.isDestroyed() ? '' : this.contents.getURL()
  }

  getTitle(): string {
    return this.contents.isDestroyed() ? '' : this.contents.getTitle()
  }

  isDestroyed(): boolean {
    return this.contents.isDestroyed()
  }

  isLoading(): boolean {
    return !this.contents.isDestroyed() && this.contents.isLoading()
  }

  async loadURL(url: string): Promise<void> {
    await this.contents.loadURL(url)
  }

  stop(): void {
    if (!this.contents.isDestroyed()) this.contents.stop()
  }

  async close(): Promise<void> {
    if (this.contents.isDestroyed()) return
    this.closing = true
    this.humanTakeoverVisible = false
    this.detachDebugger()
    this.clearListeners()
    if (!this.attached) {
      if (this.ownerWindow && !this.ownerWindow.isDestroyed()) this.ownerWindow.destroy()
      else this.contents.close({ waitForBeforeUnload: false })
    }
  }

  showForHumanTakeover(): void {
    if (!this.ownerWindow || this.ownerWindow.isDestroyed() || this.contents.isDestroyed()) {
      throw new Error('This browser surface cannot be shown for human takeover')
    }
    this.humanTakeoverVisible = true
    this.ownerWindow.setSkipTaskbar(false)
    this.ownerWindow.center()
    this.updateTakeoverTitle()
    this.ownerWindow.show()
    this.ownerWindow.focus()
    this.contents.focus()
  }

  hideHumanTakeover(): void {
    this.humanTakeoverVisible = false
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.setSkipTaskbar(true)
      this.ownerWindow.setPosition(-32_000, -32_000, false)
      if (!this.ownerWindow.isVisible()) this.ownerWindow.showInactive()
    }
  }

  isHumanTakeoverVisible(): boolean {
    return Boolean(
      this.humanTakeoverVisible &&
      this.ownerWindow &&
      !this.ownerWindow.isDestroyed() &&
      this.ownerWindow.isVisible()
    )
  }

  private updateTakeoverTitle(): void {
    if (!this.humanTakeoverVisible || !this.ownerWindow || this.ownerWindow.isDestroyed()) return
    let origin = 'unknown origin'
    try {
      const url = new URL(this.contents.getURL())
      origin = url.protocol === 'file:' ? 'local file' : url.origin
    } catch {
      // Keep a main-process-owned title even for a transient navigation URL.
    }
    this.ownerWindow.setTitle(`SideKick Browser — ${origin}`)
  }

  focus(): void {
    if (!this.contents.isDestroyed()) this.contents.focus()
  }

  async insertText(text: string): Promise<void> {
    await this.contents.insertText(text)
  }

  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void {
    this.contents.sendInputEvent(event)
  }

  resizeViewport(viewport: BrowserViewport): void {
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.setContentSize(viewport.width, viewport.height, false)
    }
  }

  async executeJavaScript<T>(source: string): Promise<T> {
    return (await this.contents.executeJavaScript(source, true)) as T
  }

  async captureViewport(): Promise<NativeBrowserSurfaceCapture> {
    this.contents.invalidate()
    let image =
      this.ownerWindow && !this.ownerWindow.isDestroyed()
        ? await this.ownerWindow.capturePage(undefined, { stayHidden: true, stayAwake: true })
        : await this.contents.capturePage()
    let size = image.getSize()
    // Electron's capturePage() returns native device pixels on high-DPI displays,
    // while Chromium mouse coordinates and our BrowserTarget contract use CSS
    // viewport pixels. Normalize the image to window.innerWidth/innerHeight so a
    // point selected from the screenshot maps 1:1 back to sendInputEvent(). This
    // also avoids sending a 3x-larger image to vision models on 300% Windows DPI.
    const cssViewport = await this.executeJavaScript<{ width: number; height: number }>(
      `(() => ({ width: window.innerWidth, height: window.innerHeight }))()`
    ).catch(() => undefined)
    if (
      cssViewport &&
      Number.isFinite(cssViewport.width) &&
      Number.isFinite(cssViewport.height) &&
      cssViewport.width >= 1 &&
      cssViewport.height >= 1 &&
      (size.width !== Math.round(cssViewport.width) ||
        size.height !== Math.round(cssViewport.height))
    ) {
      image = image.resize({
        width: Math.round(cssViewport.width),
        height: Math.round(cssViewport.height),
        quality: 'good'
      })
      size = image.getSize()
    }
    let png = image.toPNG()
    for (let attempt = 0; png.byteLength > MAX_MODEL_SCREENSHOT_BYTES && attempt < 4; attempt++) {
      const ratio = Math.min(0.85, Math.sqrt(MAX_MODEL_SCREENSHOT_BYTES / png.byteLength) * 0.9)
      const width = Math.max(320, Math.floor(size.width * ratio))
      if (width >= size.width) break
      image = image.resize({ width, quality: 'good' })
      png = image.toPNG()
      size = image.getSize()
    }
    if (png.byteLength > MAX_MODEL_SCREENSHOT_BYTES) {
      throw new Error('Browser viewport screenshot exceeds the 8 MiB vision input limit')
    }
    return { png, width: size.width, height: size.height }
  }

  async attachDebugger(): Promise<void> {
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3')
      this.debuggerOwned = true
    }
    await Promise.all([
      this.contents.debugger.sendCommand('Page.enable'),
      this.contents.debugger.sendCommand('DOM.enable'),
      this.contents.debugger.sendCommand('Runtime.enable'),
      this.contents.debugger.sendCommand('Network.enable'),
      this.contents.debugger.sendCommand('Accessibility.enable')
    ])
  }

  detachDebugger(): void {
    if (!this.contents.isDestroyed() && this.debuggerOwned && this.contents.debugger.isAttached()) {
      this.contents.debugger.detach()
    }
    this.debuggerOwned = false
  }

  async sendDebuggerCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (
      method === 'Page.captureScreenshot' &&
      this.ownerWindow &&
      !this.ownerWindow.isDestroyed() &&
      !this.ownerWindow.isVisible()
    ) {
      this.ownerWindow.setSkipTaskbar(true)
      this.ownerWindow.setPosition(-32_000, -32_000, false)
      this.ownerWindow.showInactive()
    }
    return (await this.contents.debugger.sendCommand(method, params)) as T
  }

  setNavigationGuard(guard: (url: string) => boolean): void {
    this.navigationGuard = guard
  }

  setRequestGuard(guard: (url: string) => boolean): void {
    if (this.attached) return
    this.contents.session.webRequest.onBeforeRequest(
      { urls: ['file://*/*'] },
      (details, callback) => callback({ cancel: !guard(details.url) })
    )
  }

  onConsole(listener: (message: NativeBrowserSurfaceConsoleMessage) => void): () => void {
    this.consoleListeners.add(listener)
    return () => this.consoleListeners.delete(listener)
  }

  onLoadFailure(listener: (failure: NativeBrowserSurfaceLoadFailure) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  onDebuggerMessage(
    listener: (method: string, params: Record<string, unknown>) => void
  ): () => void {
    this.debuggerListeners.add(listener)
    return () => this.debuggerListeners.delete(listener)
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyedListeners.add(listener)
    return () => this.destroyedListeners.delete(listener)
  }

  onOpenUrl(listener: (url: string) => void): () => void {
    this.openUrlListeners.add(listener)
    return () => this.openUrlListeners.delete(listener)
  }

  private clearListeners(): void {
    this.consoleListeners.clear()
    this.failureListeners.clear()
    this.debuggerListeners.clear()
    this.destroyedListeners.clear()
    this.openUrlListeners.clear()
  }
}

class ElectronNativeBrowserRuntime implements NativeBrowserRuntime {
  private readonly securedSessions = new WeakSet<object>()

  async createSurface(options: {
    partition: string
    viewport: BrowserViewport
  }): Promise<NativeBrowserSurface> {
    const electron = await import('electron')
    await electron.app.whenReady()
    const window = new electron.BrowserWindow({
      show: false,
      x: -32_000,
      y: -32_000,
      width: options.viewport.width,
      height: options.viewport.height,
      useContentSize: true,
      title: 'SideKick Browser',
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#090b0e',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        // Use a normal WebContents so this exact tab can be revealed for
        // same-session human takeover. Full-page CDP capture briefly wakes
        // the window offscreen to keep Chromium's compositor responsive.
        offscreen: false,
        devTools: false
      }
    })
    window.webContents.setBackgroundThrottling(false)
    const browserSession = window.webContents.session
    const { installBrowserPdfProtocol } = await import('../bootstrap/artifactProtocol')
    await installBrowserPdfProtocol(browserSession.protocol)
    if (!this.securedSessions.has(browserSession)) {
      this.securedSessions.add(browserSession)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false)
      })
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.on('will-download', (event) => event.preventDefault())
    }
    // Keep Chromium's compositor live for background automation without
    // putting the browser in the taskbar or on a usable display. Takeover
    // moves this exact window on screen; completion parks it here again.
    window.showInactive()
    return new ElectronNativeBrowserSurface(window.webContents, window, false)
  }

  async attachSurface(webContentsId: number): Promise<NativeBrowserSurface> {
    const electron = await import('electron')
    await electron.app.whenReady()
    const contents = electron.webContents.fromId(webContentsId)
    if (!contents || contents.isDestroyed()) throw new Error('Browser WebContents is unavailable')
    return new ElectronNativeBrowserSurface(contents, null, true)
  }
}

export class NativeBrowserSessionService {
  private readonly sessions = new Map<string, SessionState>()
  private readonly runtime: NativeBrowserRuntime
  private readonly artifactRoot: string
  private readonly defaultAllowedFileRoots: string[]
  private readonly maxSessionsPerRun: number
  private readonly maxTotalSessions: number
  private readonly maxTabsPerSession: number
  private readonly maxArtifacts: number
  private readonly maxArtifactBytes: number
  private readonly artifactRetentionMs: number
  private readonly maxTelemetryEntries: number
  private readonly maxRepeatedNoChangeActions: number
  private readonly defaultViewport: BrowserViewport
  private readonly now: () => number
  private artifactTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NativeBrowserSessionServiceOptions) {
    if (!options.artifactRoot) throw new Error('A browser artifact root is required')
    this.artifactRoot = resolve(options.artifactRoot)
    this.defaultAllowedFileRoots = (options.allowedFileRoots ?? []).map((root) => resolve(root))
    this.runtime = options.runtime ?? new ElectronNativeBrowserRuntime()
    this.maxSessionsPerRun = boundedInteger(
      options.maxSessionsPerRun ?? DEFAULT_MAX_SESSIONS_PER_RUN,
      1,
      16,
      'maxSessionsPerRun'
    )
    this.maxTotalSessions = boundedInteger(
      options.maxTotalSessions ?? DEFAULT_MAX_TOTAL_SESSIONS,
      1,
      32,
      'maxTotalSessions'
    )
    this.maxTabsPerSession = boundedInteger(
      options.maxTabsPerSession ?? DEFAULT_MAX_TABS,
      1,
      32,
      'maxTabsPerSession'
    )
    this.maxArtifacts = boundedInteger(
      options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
      1,
      10_000,
      'maxArtifacts'
    )
    this.maxArtifactBytes = boundedInteger(
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      1024 * 1024,
      2_000_000_000,
      'maxArtifactBytes'
    )
    this.artifactRetentionMs = boundedInteger(
      options.artifactRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
      'artifactRetentionMs'
    )
    this.maxTelemetryEntries = boundedInteger(
      options.maxTelemetryEntries ?? DEFAULT_MAX_TELEMETRY,
      50,
      20_000,
      'maxTelemetryEntries'
    )
    this.maxRepeatedNoChangeActions = boundedInteger(
      options.maxRepeatedNoChangeActions ?? DEFAULT_MAX_REPEATED_NO_CHANGE,
      1,
      20,
      'maxRepeatedNoChangeActions'
    )
    this.defaultViewport = this.normalizeViewport(options.defaultViewport ?? DEFAULT_VIEWPORT)
    this.now = options.now ?? Date.now
  }

  async open(
    input: BrowserOpenInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserObservation> {
    const signal = currentSignal(operation, this.now)
    if (!input.runId.trim()) throw new Error('A browser runId is required')
    if (this.sessions.size >= this.maxTotalSessions) {
      throw new Error(`The browser session limit (${this.maxTotalSessions}) is reached`)
    }
    const runCount = [...this.sessions.values()].filter(
      (session) => session.runId === input.runId
    ).length
    if (runCount >= this.maxSessionsPerRun) {
      throw new Error(
        `Run ${input.runId} already has the maximum ${this.maxSessionsPerRun} browser sessions`
      )
    }

    const viewport = this.normalizeViewport(input.viewport ?? this.defaultViewport)
    const allowedFileRoots = await this.resolveFileRoots(input.allowedFileRoots ?? [])
    const initialUrl = input.url
      ? await this.normalizeNavigationUrl(input.url, allowedFileRoots)
      : undefined
    const id = randomUUID()
    const partition = `sidekick-browser-${safeSegment(input.runId)}-${id}`
    let surface: NativeBrowserSurface | undefined
    try {
      if (input.attachWebContentsId !== undefined) {
        const allowlisted = this.options.allowedAttachWebContentsIds?.has(input.attachWebContentsId)
        if (!allowlisted && !this.options.canAttachWebContents) {
          throw new Error('Attaching arbitrary WebContents is disabled')
        }
        surface = await abortable(this.runtime.attachSurface(input.attachWebContentsId), signal)
        if (
          !allowlisted &&
          !this.options.canAttachWebContents?.(input.attachWebContentsId, surface.getURL())
        ) {
          await surface.close()
          throw new Error('This WebContents is not approved for browser attachment')
        }
        const attachedUrl = surface.getURL() || 'about:blank'
        if (new URL(attachedUrl).protocol === 'file:') {
          throw new Error('Attaching an existing file:// WebContents is not supported')
        }
        await this.normalizeNavigationUrl(attachedUrl, allowedFileRoots)
      } else {
        surface = await abortable(this.runtime.createSurface({ partition, viewport }), signal)
        // A committed document is required before Accessibility/DOM domains are enabled.
        await this.commitBlankDocument(surface, signal)
      }

      const session: SessionState = {
        id,
        runId: input.runId,
        partition,
        allowedFileRoots,
        tabs: new Map(),
        activeTabId: '',
        console: [],
        failures: [],
        consoleSequence: 0,
        networkSequence: 0,
        tail: Promise.resolve(),
        createdAt: this.now()
      }
      this.sessions.set(id, session)
      const tab = await this.registerSurface(session, surface, signal)
      session.activeTabId = tab.id
      if (initialUrl) {
        await this.navigateUnlocked(session, tab, initialUrl, signal)
      }
      return await this.observeUnlocked(
        session,
        {
          tabId: tab.id,
          screenshot: 'viewport',
          includeSemanticSnapshot: true
        },
        signal
      )
    } catch (error) {
      this.sessions.delete(id)
      if (surface) {
        await abortable(surface.close(), AbortSignal.timeout(2_000)).catch(() => undefined)
      }
      throw error
    }
  }

  async attach(
    input: BrowserOpenInput & { attachWebContentsId: number },
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserObservation> {
    return this.open(input, operation)
  }

  private normalizeViewport(viewport: BrowserViewport): BrowserViewport {
    return {
      width: boundedInteger(viewport.width, 320, 3840, 'viewport width'),
      height: boundedInteger(viewport.height, 240, 2160, 'viewport height'),
      deviceScaleFactor: Math.max(0.5, Math.min(4, viewport.deviceScaleFactor ?? 1))
    }
  }

  private async resolveFileRoots(sessionRoots: string[]): Promise<string[]> {
    const roots = [...this.defaultAllowedFileRoots, ...sessionRoots]
    const result: string[] = []
    for (const root of roots) {
      if (!isAbsolute(root)) throw new Error('Browser file roots must be absolute')
      const normalized = resolve(root)
      if (!basename(normalized)) throw new Error('A filesystem root cannot be a browser file root')
      let realRoot: string
      try {
        const stat = await fs.stat(normalized)
        if (!stat.isDirectory()) throw new Error('Browser file roots must be directories')
        realRoot = await fs.realpath(normalized)
      } catch (error) {
        if (error instanceof Error && error.message === 'Browser file roots must be directories') {
          throw error
        }
        throw new Error(`Browser file root does not exist: ${normalized}`)
      }
      if (!result.includes(realRoot)) result.push(realRoot)
    }
    return result
  }

  private navigationUrlAllowedSync(input: string, allowedFileRoots: string[]): boolean {
    try {
      const url = new URL(input)
      if (url.username || url.password) return false
      if (url.protocol === 'about:') return url.href === 'about:blank'
      if (url.protocol === 'https:') return true
      if (url.protocol === 'http:') return loopbackHost(url.hostname)
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return false
      // The native implementation expands Windows 8.3 aliases (for example
      // RUNNER~1), keeping request checks aligned with async fs.realpath roots.
      const candidate = realpathSync.native(resolve(fileURLToPath(url)))
      return allowedFileRoots.some((root) => isPathWithin(root, candidate))
    } catch {
      return false
    }
  }

  private async normalizeNavigationUrl(input: string, allowedFileRoots: string[]): Promise<string> {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw new Error('Browser URLs must be absolute')
    }
    if (url.username || url.password) throw new Error('Browser URLs cannot contain credentials')
    if (url.protocol === 'about:' && url.href === 'about:blank') return url.href
    if (url.protocol === 'https:') return url.href
    if (url.protocol === 'http:') {
      if (!loopbackHost(url.hostname)) {
        throw new Error('Plain HTTP is allowed only for loopback development servers')
      }
      return url.href
    }
    if (url.protocol !== 'file:') {
      throw new Error('Only HTTPS, loopback HTTP, and approved local file URLs are supported')
    }
    if (url.hostname && url.hostname !== 'localhost') {
      throw new Error('Remote file URLs are not supported')
    }
    if (!allowedFileRoots.length) throw new Error('Local file browsing is not enabled')
    const requestedPath = resolve(fileURLToPath(url))
    let realPath: string
    try {
      realPath = await fs.realpath(requestedPath)
    } catch {
      throw new Error('The local browser file does not exist')
    }
    let allowed = false
    for (const root of allowedFileRoots) {
      if (isPathWithin(root, realPath)) {
        allowed = true
        break
      }
    }
    if (!allowed) throw new Error('Local browser files must remain inside an approved project root')
    // Load the canonical path so the synchronous navigation/request guards compare
    // the same Windows path form even when TEMP uses an 8.3 alias (RUNNER~1).
    return pathToFileURL(realPath).href
  }

  private async registerSurface(
    session: SessionState,
    surface: NativeBrowserSurface,
    signal?: AbortSignal
  ): Promise<TabState> {
    if (session.tabs.size >= this.maxTabsPerSession) {
      await surface.close()
      throw new Error(`The browser tab limit (${this.maxTabsPerSession}) is reached`)
    }
    surface.setNavigationGuard(
      (url) =>
        this.navigationUrlAllowedSync(url, session.allowedFileRoots) ||
        browserPdfUrlAllowed(url, session.id)
    )
    surface.setRequestGuard((url) => this.navigationUrlAllowedSync(url, session.allowedFileRoots))
    await abortable(surface.attachDebugger(), signal)
    const tab: TabState = {
      id: randomUUID(),
      surface,
      pdfSessionTokens: new Set(),
      refEpoch: 1,
      refs: new Map(),
      semanticNodes: [],
      consoleCursor: session.consoleSequence,
      networkCursor: session.networkSequence,
      lastScreenshotHashes: {},
      unchangedScreenshotStreaks: {},
      inFlight: new Map(),
      actionHistory: [],
      disposers: []
    }
    session.tabs.set(tab.id, tab)
    tab.disposers.push(
      surface.onConsole((message) => this.recordConsole(session, tab, message)),
      surface.onLoadFailure((failure) => this.recordLoadFailure(session, tab, failure)),
      surface.onDebuggerMessage((method, params) =>
        this.handleDebuggerMessage(session, tab, method, params)
      ),
      surface.onDestroyed(() => this.handleSurfaceDestroyed(session, tab)),
      surface.onOpenUrl((url) => {
        void this.openPopup(session, tab, url).catch((error) => {
          this.recordConsole(session, tab, {
            level: 'error',
            message: `Blocked popup: ${error instanceof Error ? error.message : String(error)}`
          })
        })
      })
    )
    return tab
  }

  private recordConsole(
    session: SessionState,
    tab: TabState,
    message: NativeBrowserSurfaceConsoleMessage
  ): void {
    session.console.push({
      sequence: ++session.consoleSequence,
      tabId: tab.id,
      timestamp: this.now(),
      ...message
    })
    if (session.console.length > this.maxTelemetryEntries) {
      session.console.splice(0, session.console.length - this.maxTelemetryEntries)
    }
  }

  private recordLoadFailure(
    session: SessionState,
    tab: TabState,
    failure: NativeBrowserSurfaceLoadFailure
  ): void {
    session.failures.push({
      sequence: ++session.networkSequence,
      tabId: tab.id,
      timestamp: this.now(),
      url: failure.url,
      errorText: failure.errorText,
      canceled: failure.canceled ?? false
    })
    this.trimNetworkTelemetry(session)
  }

  private trimNetworkTelemetry(session: SessionState): void {
    if (session.failures.length > this.maxTelemetryEntries) {
      session.failures.splice(0, session.failures.length - this.maxTelemetryEntries)
    }
  }

  private handleDebuggerMessage(
    session: SessionState,
    tab: TabState,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (method === 'Network.requestWillBeSent') {
      const requestId = String(params.requestId ?? '')
      const request = (params.request ?? {}) as Record<string, unknown>
      const resourceType = String(params.type ?? '')
      if (requestId) {
        tab.inFlight.set(requestId, {
          url: String(request.url ?? ''),
          method: request.method ? String(request.method) : undefined,
          resourceType: resourceType || undefined,
          ignoredForIdle: resourceType === 'WebSocket' || resourceType === 'EventSource',
          startedAt: this.now()
        })
      }
      return
    }
    if (method === 'Network.loadingFinished') {
      tab.inFlight.delete(String(params.requestId ?? ''))
      return
    }
    if (method === 'Network.loadingFailed') {
      const requestId = String(params.requestId ?? '')
      const request = tab.inFlight.get(requestId)
      tab.inFlight.delete(requestId)
      session.failures.push({
        sequence: ++session.networkSequence,
        tabId: tab.id,
        timestamp: this.now(),
        url: request?.url ?? tab.surface.getURL(),
        method: request?.method,
        resourceType: request?.resourceType,
        errorText: String(params.errorText ?? 'Network request failed'),
        canceled: Boolean(params.canceled)
      })
      this.trimNetworkTelemetry(session)
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = (params.frame ?? {}) as Record<string, unknown>
      if (!frame.parentId) this.invalidateSemanticRefs(tab)
      return
    }
    if (method === 'Page.navigatedWithinDocument') this.invalidateSemanticRefs(tab)
  }

  private invalidateSemanticRefs(tab: TabState): void {
    tab.refEpoch++
    tab.refs.clear()
    tab.semanticNodes = []
    tab.lastViewportScreenshot = undefined
  }

  private handleSurfaceDestroyed(session: SessionState, tab: TabState): void {
    for (const token of tab.pdfSessionTokens) revokeBrowserPdfSession(token)
    tab.pdfSessionTokens.clear()
    for (const dispose of tab.disposers.splice(0)) dispose()
    session.tabs.delete(tab.id)
    if (session.humanTakeoverTabId === tab.id) session.humanTakeoverTabId = undefined
    if (session.activeTabId === tab.id) session.activeTabId = session.tabs.keys().next().value ?? ''
    if (!session.tabs.size) {
      revokeBrowserPdfSessionsByOwner(session.id)
      this.sessions.delete(session.id)
    }
  }

  private async createOwnedTab(
    session: SessionState,
    viewport: BrowserViewport,
    signal?: AbortSignal
  ): Promise<TabState> {
    let surface: NativeBrowserSurface | undefined
    try {
      surface = await abortable(
        this.runtime.createSurface({ partition: session.partition, viewport }),
        signal
      )
      // CDP Accessibility/DOM domains can stall until Chromium commits its first document.
      await this.commitBlankDocument(surface, signal)
      return await this.registerSurface(session, surface, signal)
    } catch (error) {
      if (surface) {
        await abortable(surface.close(), AbortSignal.timeout(2_000)).catch(() => undefined)
      }
      throw error
    }
  }

  private async commitBlankDocument(
    surface: NativeBrowserSurface,
    signal?: AbortSignal
  ): Promise<void> {
    const blankIsReady = async (): Promise<boolean> => {
      if (surface.getURL() !== 'about:blank') return false
      try {
        const readyState = await abortable(
          surface.executeJavaScript<string>('document.readyState'),
          signal
        )
        return readyState === 'interactive' || readyState === 'complete'
      } catch (error) {
        if (signal?.aborted) throw error
        return false
      }
    }

    // BrowserWindow starts its own about:blank navigation. Loading the same URL before
    // it commits can supersede that navigation and produce ERR_FAILED on Electron 43.
    for (let poll = 0; poll < 10; poll++) {
      if (await blankIsReady()) return
      await delay(25, signal)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await abortable(surface.loadURL('about:blank'), signal)
        if (await blankIsReady()) return
        lastError = new Error('Chromium did not commit the browser bootstrap document')
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error
      }

      // Electron 43 on Windows may reject a superseded about:blank load before
      // getURL catches up. Give the committed navigation a short, bounded window.
      for (let poll = 0; poll < 4; poll++) {
        if (await blankIsReady()) return
        await delay(25, signal)
      }
      if (attempt === 0) surface.stop()
    }
    if (await blankIsReady()) return
    throw lastError instanceof Error
      ? lastError
      : new Error('Chromium failed to commit the browser bootstrap document')
  }

  private async openPopup(
    session: SessionState,
    opener: TabState,
    inputUrl: string
  ): Promise<void> {
    const url = await this.normalizeNavigationUrl(inputUrl, session.allowedFileRoots)
    await this.withSessionLock(session, {}, async (signal) => {
      if (session.humanTakeoverTabId === opener.id && session.tabs.has(opener.id)) {
        // A popup cannot safely become a second hidden window while the user
        // owns the visible takeover surface. Keep the navigation in that exact
        // window so completion always recaptures what the user interacted with.
        session.activeTabId = opener.id
        await this.navigateUnlocked(session, opener, url, signal)
        return
      }
      const viewport = await this.currentViewport(this.getTab(session))
      const tab = await this.createOwnedTab(session, viewport, signal)
      session.activeTabId = tab.id
      try {
        await this.navigateUnlocked(session, tab, url, signal)
      } catch (error) {
        await this.closeTab(session, tab)
        throw error
      }
    })
  }

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Browser session not found or already closed')
    return session
  }

  private getTab(session: SessionState, tabId?: string): TabState {
    const id = tabId ?? session.activeTabId
    const tab = session.tabs.get(id)
    if (!tab || tab.surface.isDestroyed())
      throw new Error('Browser tab not found or already closed')
    return tab
  }

  private async withSessionLock<T>(
    session: SessionState,
    operation: BrowserOperationOptions,
    body: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    const signal = currentSignal(operation, this.now)
    let release!: () => void
    const turn = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const previous = session.tail.catch(() => undefined)
    session.tail = previous.then(() => turn)
    try {
      await abortable(previous, signal)
      return await body(signal)
    } finally {
      release()
    }
  }

  private tabSummary(session: SessionState, tab: TabState): BrowserTabSummary {
    return {
      id: tab.id,
      webContentsId: tab.surface.webContentsId,
      title: tab.surface.getTitle(),
      url: this.tabUrl(tab),
      active: tab.id === session.activeTabId,
      loading: tab.surface.isLoading(),
      attached: tab.surface.attached
    }
  }

  private tabUrl(tab: TabState): string {
    return tab.logicalUrl ?? tab.surface.getURL()
  }

  private tabSummaries(session: SessionState): BrowserTabSummary[] {
    return [...session.tabs.values()].map((tab) => this.tabSummary(session, tab))
  }

  async navigate(
    input: BrowserNavigateInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const navigationAction = input.action ?? (input.url ? 'url' : undefined)
      if (!navigationAction) throw new Error('Browser navigation requires a url or history action')
      let url: string | undefined
      if (navigationAction === 'url') {
        if (!input.url) throw new Error('URL navigation requires a url')
        url = await this.normalizeNavigationUrl(input.url, session.allowedFileRoots)
      } else if (input.url) {
        throw new Error(`${navigationAction} navigation does not accept a url`)
      }
      const startedAt = this.now()
      const fingerprint = canonicalFingerprint({
        action: 'navigate',
        navigationAction,
        tabId: tab.id,
        url
      })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      tab.lastPointer = undefined
      let navigationQuiescence: BrowserQuiescenceResult
      if (navigationAction === 'url') {
        navigationQuiescence = await this.navigateUnlocked(session, tab, url!, signal)
      } else if (navigationAction === 'reload') {
        await this.normalizeNavigationUrl(this.tabUrl(tab), session.allowedFileRoots)
        this.invalidateSemanticRefs(tab)
        await abortable(tab.surface.sendDebuggerCommand('Page.reload'), signal)
        if (tab.pdfSessionToken) await this.waitForPdfViewerReady(session, tab, signal)
        navigationQuiescence = await this.waitForQuiescence(
          tab,
          this.navigationQuiescence(tab.surface.getURL()),
          signal
        )
      } else {
        const history = await abortable(
          tab.surface.sendDebuggerCommand<{
            currentIndex: number
            entries: Array<{ id: number; url: string; title?: string }>
          }>('Page.getNavigationHistory'),
          signal
        )
        const index = history.currentIndex + (navigationAction === 'back' ? -1 : 1)
        const entry = history.entries[index]
        if (!entry)
          throw new Error(`Browser cannot navigate ${navigationAction}; no history entry exists`)
        const pdfSession = getBrowserPdfSession(entry.url)
        const entryUrl = pdfSession ? pathToFileURL(pdfSession.sourcePath).href : entry.url
        await this.normalizeNavigationUrl(entryUrl, session.allowedFileRoots)
        this.invalidateSemanticRefs(tab)
        await abortable(
          tab.surface.sendDebuggerCommand('Page.navigateToHistoryEntry', { entryId: entry.id }),
          signal
        )
        if (pdfSession) await this.waitForPdfViewerReady(session, tab, signal)
        navigationQuiescence = await this.waitForQuiescence(
          tab,
          this.navigationQuiescence(entry.url),
          signal
        )
        tab.logicalUrl = pdfSession ? entryUrl : undefined
        tab.pdfSessionToken = pdfSession?.token
      }
      return this.finishAction(
        session,
        tab,
        `navigate:${navigationAction}`,
        'page',
        false,
        fingerprint,
        startedAt,
        signal,
        navigationQuiescence
      )
    })
  }

  private async navigateUnlocked(
    session: SessionState,
    tab: TabState,
    url: string,
    signal?: AbortSignal
  ): Promise<BrowserQuiescenceResult> {
    tab.lastPointer = undefined
    this.invalidateSemanticRefs(tab)
    let navigationUrl = url
    let newPdfToken: string | undefined
    if (new URL(url).protocol === 'file:' && extname(fileURLToPath(url)).toLowerCase() === '.pdf') {
      const pdfSession = createBrowserPdfSession(fileURLToPath(url), session.id)
      newPdfToken = pdfSession.token
      tab.pdfSessionTokens.add(pdfSession.token)
      navigationUrl = browserPdfViewerUrl(pdfSession)
    }
    try {
      await abortable(tab.surface.loadURL(navigationUrl), signal)
      if (newPdfToken) await this.waitForPdfViewerReady(session, tab, signal)
    } catch (error) {
      if (signal?.aborted) tab.surface.stop()
      if (newPdfToken) {
        tab.pdfSessionTokens.delete(newPdfToken)
        revokeBrowserPdfSession(newPdfToken)
      }
      throw error
    }
    tab.logicalUrl = newPdfToken ? url : undefined
    tab.pdfSessionToken = newPdfToken
    return this.waitForQuiescence(tab, this.navigationQuiescence(navigationUrl), signal)
  }

  private async waitForPdfViewerReady(
    session: SessionState,
    tab: TabState,
    signal?: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await abortable(
        tab.surface.executeJavaScript<string>(
          `document.documentElement?.dataset.sidekickPdfReady === 'true' ? 'ready' : (document.documentElement?.dataset.sidekickPdfError === 'true' ? 'error' : 'loading')`
        ),
        signal
      )
      if (state === 'ready') return
      if (state === 'error') {
        const message = await abortable(
          tab.surface.executeJavaScript<string>(
            `document.querySelector('#status')?.textContent || 'The PDF viewer could not render this document'`
          ),
          signal
        )
        throw new Error(String(message))
      }
      await delay(100, signal)
    }
    const diagnostics = await abortable(
      tab.surface.executeJavaScript<unknown>(`(async () => {
        const probe = async (url) => {
          try {
            const response = await fetch(url);
            return { url: response.url, status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
          } catch (error) {
            return { error: String(error) };
          }
        };
        return {
          url: location.href,
          title: document.title,
          state: document.readyState,
          status: document.querySelector('#status')?.textContent,
          scripts: [...document.scripts].map((script) => script.src),
          resources: performance.getEntriesByType('resource').map((entry) => entry.name),
          viewerModule: await probe('./viewer.mjs'),
          pdfModule: await probe('./pdf.mjs')
        };
      })()`),
      signal
    ).catch(() => undefined)
    throw timeoutError(
      `The PDF viewer did not become ready within 30 seconds${diagnostics ? `: ${JSON.stringify(diagnostics)}` : ''}; console=${JSON.stringify(session.console.filter((entry) => entry.tabId === tab.id).slice(-10))}`
    )
  }

  private navigationQuiescence(url: string): { idleMs?: number; maxWaitMs?: number } {
    const parsed = new URL(url)
    if (
      parsed.protocol === 'file:' ||
      parsed.protocol === 'about:' ||
      parsed.protocol === 'sidekick-pdf:'
    ) {
      // loadURL has already reached the document load event. Local previews have
      // no meaningful network-idle phase, so do not leave the first frame hidden
      // behind the general remote-page settling budget.
      return { idleMs: 100, maxWaitMs: 750 }
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      return { idleMs: 200, maxWaitMs: 2_000 }
    }
    return {}
  }

  async observe(
    sessionId: string,
    options: BrowserObservationOptions = {},
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserObservation> {
    const session = this.getSession(sessionId)
    return this.withSessionLock(session, operation, (signal) =>
      this.observeUnlocked(session, options, signal)
    )
  }

  private async observeUnlocked(
    session: SessionState,
    options: BrowserObservationOptions,
    signal?: AbortSignal
  ): Promise<BrowserObservation> {
    const tab = this.getTab(session, options.tabId)
    const viewport = await abortable(this.currentViewport(tab), signal)
    let semanticSnapshot: string | undefined
    let semanticNodeCount: number | undefined
    if (options.includeSemanticSnapshot !== false) {
      const semantic = await this.captureSemanticSnapshot(tab, options.semanticDepth, signal)
      semanticSnapshot = semantic.snapshot
      semanticNodeCount = semantic.count
    }
    const screenshotKind = options.screenshot ?? 'viewport'
    const screenshot =
      screenshotKind === 'none'
        ? undefined
        : await this.captureAndStore(session, tab, screenshotKind, undefined, signal)
    const consoleEntries = session.console.filter(
      (entry) => entry.tabId === tab.id && entry.sequence > tab.consoleCursor
    )
    const failures = session.failures.filter(
      (entry) => entry.tabId === tab.id && entry.sequence > tab.networkCursor
    )
    tab.consoleCursor = session.consoleSequence
    tab.networkCursor = session.networkSequence
    const humanVerification = await this.detectHumanVerification(tab, semanticSnapshot, signal)
    return {
      sessionId: session.id,
      runId: session.runId,
      observedAt: this.now(),
      tab: this.tabSummary(session, tab),
      tabs: this.tabSummaries(session),
      viewport,
      pointer: tab.lastPointer ?? null,
      semanticSnapshot,
      semanticNodeCount,
      humanVerification,
      screenshot,
      screenshotChanged: screenshot?.changed ?? null,
      unchangedScreenshotStreak:
        screenshot?.unchangedStreak ?? tab.unchangedScreenshotStreaks.viewport ?? 0,
      console: consoleEntries,
      failedRequests: failures,
      cursors: { console: session.consoleSequence, network: session.networkSequence }
    }
  }

  private async currentViewport(tab: TabState): Promise<BrowserViewport> {
    try {
      const value = await tab.surface.executeJavaScript<{
        width: number
        height: number
        deviceScaleFactor: number
      }>(
        `(() => ({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 }))()`
      )
      return this.normalizeViewport(value)
    } catch {
      return this.defaultViewport
    }
  }

  private async detectHumanVerification(
    tab: TabState,
    semanticSnapshot: string | undefined,
    signal?: AbortSignal
  ): Promise<BrowserHumanVerification | null> {
    const domState = await abortable(
      tab.surface
        .executeJavaScript<{
          pageText: string
          unresolvedMarker: boolean
          solvedKnownWidget: boolean
        }>(
          `(() => {
          const visible = node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const nodesFor = selectors => Array.from(new Set(
            selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
          ));
          const visibleNodes = selectors => nodesFor(selectors).filter(visible);
          const responseCount = selectors => nodesFor(selectors).filter(node =>
            typeof node.value === 'string' && node.value.trim().length > 8
          ).length;
          const challengeCheckboxes = nodesFor(['[role="checkbox"]', 'input[type="checkbox"]']).filter(node => {
            const label = [
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
              node.textContent,
              node.parentElement?.textContent
            ].filter(Boolean).join(' ');
            return /captcha|not\\s+a\\s+robot|verify|human/i.test(label);
          });
          const checkboxSolved = node => node.matches(':checked') || node.getAttribute('aria-checked') === 'true';
          const solvedCheckbox = challengeCheckboxes.some(checkboxSolved);
          const unresolvedCheckbox = challengeCheckboxes.some(node => !checkboxSolved(node) && visible(node));
          const recaptchaSolved = responseCount(['textarea[name="g-recaptcha-response"]', 'input[name="g-recaptcha-response"]']);
          const hcaptchaSolved = responseCount(['textarea[name="h-captcha-response"]', 'input[name="h-captcha-response"]']);
          const turnstileSolved = responseCount(['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]']);
          const widgetCount = (containerSelector, iframeSelectors) => {
            const containers = visibleNodes([containerSelector]).length;
            if (containers) return containers;
            return visibleNodes(iframeSelectors).length > 0 ? 1 : 0;
          };
          const recaptchaVisible = widgetCount('.g-recaptcha', ['iframe[src*="recaptcha"]']);
          const hcaptchaVisible = widgetCount('.h-captcha', ['iframe[src*="hcaptcha"]']);
          const turnstileVisible = widgetCount('.cf-turnstile', ['iframe[src*="challenges.cloudflare.com"]']);
          const opaqueChallengeVisible = visibleNodes([
            'iframe[src*="arkoselabs"]',
            'iframe[src*="perimeterx"]'
          ]).length > 0;
          const genericCaptchaVisible = visibleNodes(['iframe[title*="captcha" i]']).some(node =>
            !/recaptcha|hcaptcha|challenges\\.cloudflare\\.com/i.test(node.getAttribute('src') || '')
          );
          const solvedKnownWidget = solvedCheckbox || recaptchaSolved > 0 || hcaptchaSolved > 0 || turnstileSolved > 0;
          return {
            pageText: (document.body?.innerText || '').slice(0, 32768),
            solvedKnownWidget,
            unresolvedMarker:
              recaptchaVisible > recaptchaSolved ||
              hcaptchaVisible > hcaptchaSolved ||
              turnstileVisible > turnstileSolved ||
              unresolvedCheckbox ||
              opaqueChallengeVisible ||
              genericCaptchaVisible
          };
        })()`
        )
        .catch(() => undefined),
      signal
    )
    if (domState?.unresolvedMarker) {
      return {
        required: true,
        kind: 'captcha_or_bot_challenge',
        message:
          'This site requires a human verification step before browser automation can continue.',
        detectedBy: 'dom_marker'
      }
    }
    return detectTextualHumanVerification(
      tab.surface.getTitle(),
      [semanticSnapshot, domState?.pageText].filter(Boolean).join('\n'),
      domState?.solvedKnownWidget === true
    )
  }

  private async captureSemanticSnapshot(
    tab: TabState,
    requestedDepth?: number,
    signal?: AbortSignal
  ): Promise<{ snapshot: string; count: number }> {
    const depth =
      requestedDepth === undefined ? undefined : boundedInteger(requestedDepth, 1, 30, 'depth')
    const response = await abortable(
      tab.surface.sendDebuggerCommand<{ nodes: CDPAXNode[] }>(
        'Accessibility.getFullAXTree',
        depth ? { depth } : undefined
      ),
      signal
    )
    const allNodes = response.nodes ?? []
    const nodes = new Map(allNodes.map((node) => [node.nodeId, node]))
    tab.refs.clear()
    tab.semanticNodes = []
    let emitted = 0
    let output = ''
    const roots = allNodes.filter((node) => !node.parentId || !nodes.has(node.parentId))

    const visit = (node: CDPAXNode, level: number): void => {
      if (emitted >= MAX_SEMANTIC_NODES || output.length >= MAX_SEMANTIC_CHARS) return
      const role = valueOf(node.role) || 'generic'
      const name = valueOf(node.name)
      const ignored = node.ignored === true
      let ref = ''
      if (!ignored && node.backendDOMNodeId && role !== 'StaticText' && role !== 'InlineTextBox') {
        ref = `ax-${tab.refEpoch}-${node.backendDOMNodeId}`
        const semanticRef: SemanticRef = {
          ref,
          backendNodeId: node.backendDOMNodeId,
          role: role.toLowerCase(),
          name,
          epoch: tab.refEpoch
        }
        tab.refs.set(ref, semanticRef)
        tab.semanticNodes.push(semanticRef)
      }
      if (!ignored && (role !== 'generic' || name || ref)) {
        const attributes: string[] = []
        if (ref) attributes.push(`ref=${ref}`)
        for (const property of node.properties ?? []) {
          if (
            [
              'disabled',
              'checked',
              'selected',
              'expanded',
              'pressed',
              'required',
              'readonly'
            ].includes(property.name) &&
            property.value?.value !== undefined
          ) {
            attributes.push(`${property.name}=${String(property.value.value)}`)
          }
        }
        const value = valueOf(node.value)
        if (value && value !== name) attributes.push(`value=${quoteSnapshot(value)}`)
        const description = valueOf(node.description)
        if (description) attributes.push(`description=${quoteSnapshot(description)}`)
        const line = `${'  '.repeat(Math.min(level, 20))}- ${role}${name ? ` ${quoteSnapshot(name)}` : ''}${attributes.length ? ` [${attributes.join(' ')}]` : ''}\n`
        if (output.length + line.length <= MAX_SEMANTIC_CHARS) {
          output += line
          emitted++
        }
      }
      for (const childId of node.childIds ?? []) {
        const child = nodes.get(childId)
        if (child) visit(child, level + (ignored ? 0 : 1))
      }
    }
    for (const root of roots) visit(root, 0)
    if (emitted >= MAX_SEMANTIC_NODES || output.length >= MAX_SEMANTIC_CHARS) {
      output += '... semantic snapshot truncated ...\n'
    }
    return { snapshot: output.trimEnd(), count: emitted }
  }

  async screenshot(
    input: BrowserScreenshotInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserScreenshotArtifact> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      return this.captureAndStore(
        session,
        tab,
        input.kind ?? (input.target ? 'element' : 'viewport'),
        input.target,
        signal
      )
    })
  }

  private async captureAndStore(
    session: SessionState,
    tab: TabState,
    kind: BrowserScreenshotKind,
    target: BrowserTarget | undefined,
    signal?: AbortSignal
  ): Promise<BrowserScreenshotArtifact> {
    const createdAt = this.now()
    const id = randomUUID()
    const captureStateBefore =
      kind === 'viewport' ? await this.coordinateCaptureState(tab, signal) : undefined
    const capture = await this.captureRaw(tab, kind, target, signal)
    const captureStateAfter =
      kind === 'viewport' ? await this.coordinateCaptureState(tab, signal) : undefined
    const stableCaptureState =
      captureStateBefore &&
      captureStateAfter &&
      this.sameCoordinateCaptureState(captureStateBefore, captureStateAfter)
        ? captureStateAfter
        : undefined
    if (kind === 'viewport') {
      tab.lastViewportScreenshot = stableCaptureState
        ? {
            id,
            imageWidth: capture.width,
            imageHeight: capture.height,
            ...stableCaptureState
          }
        : undefined
    }
    const sourceUrlAtCapture = this.tabUrl(tab)
    const sha256 = createHash('sha256').update(capture.png).digest('hex')
    const previousHash = tab.lastScreenshotHashes[kind]
    const changed = previousHash === undefined ? null : previousHash !== sha256
    const unchangedStreak = changed === false ? (tab.unchangedScreenshotStreaks[kind] ?? 0) + 1 : 0
    tab.unchangedScreenshotStreaks[kind] = unchangedStreak
    tab.lastScreenshotHashes[kind] = sha256
    const directory = join(
      this.artifactRoot,
      safeSegment(session.runId),
      safeSegment(session.id),
      safeSegment(tab.id)
    )
    const path = join(directory, `${createdAt}-${id}.png`)
    const temporaryPath = `${path}.partial`
    try {
      await fs.mkdir(directory, { recursive: true })
      const [realRoot, realDirectory] = await Promise.all([
        fs.realpath(this.artifactRoot),
        fs.realpath(directory)
      ])
      if (!isPathWithin(realRoot, realDirectory) || realDirectory === realRoot) {
        throw new Error('Browser screenshot directory escaped the artifact root')
      }
      await abortable(Promise.resolve(), signal)
      await fs.writeFile(temporaryPath, capture.png, { mode: 0o600, signal })
      await abortable(Promise.resolve(), signal)
      await fs.rename(temporaryPath, path)
      await abortable(Promise.resolve(), signal)
    } catch (error) {
      if (tab.lastViewportScreenshot?.id === id) tab.lastViewportScreenshot = undefined
      await Promise.all([
        fs.unlink(temporaryPath).catch(() => undefined),
        fs.unlink(path).catch(() => undefined)
      ])
      if (signal?.aborted) {
        if (signal.reason?.name === 'TimeoutError') {
          throw timeoutError('Browser operation timed out')
        }
        throw abortError('Browser operation cancelled')
      }
      throw error
    }
    const sessionArtifactRoot = join(
      this.artifactRoot,
      safeSegment(session.runId),
      safeSegment(session.id)
    )
    try {
      await this.enforceArtifactBounds(path, sessionArtifactRoot)
    } catch (error) {
      if (tab.lastViewportScreenshot?.id === id) tab.lastViewportScreenshot = undefined
      throw error
    }
    const relativePath = relative(this.artifactRoot, path)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      if (tab.lastViewportScreenshot?.id === id) tab.lastViewportScreenshot = undefined
      await fs.unlink(path).catch(() => undefined)
      throw new Error('Browser screenshot escaped the artifact root')
    }
    const rendererUrl = `sidekick-browser://artifact/${relativePath
      .split(/[\\/]+/)
      .map(encodeURIComponent)
      .join('/')}`
    const artifact: BrowserScreenshotArtifact = {
      id,
      sessionId: session.id,
      tabId: tab.id,
      path,
      url: rendererUrl,
      mimeType: 'image/png',
      kind,
      sourceUrl: sourceUrlAtCapture,
      width: capture.width,
      height: capture.height,
      bytes: capture.png.byteLength,
      sha256,
      createdAt,
      changed,
      unchangedStreak
    }
    return artifact
  }

  private async captureRaw(
    tab: TabState,
    kind: BrowserScreenshotKind,
    target: BrowserTarget | undefined,
    signal?: AbortSignal
  ): Promise<NativeBrowserSurfaceCapture> {
    if (kind === 'viewport') {
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await abortable(tab.surface.captureViewport(), signal)
        } catch (error) {
          lastError = error
          if (!isTransientViewportCaptureError(error) || attempt === 2) throw error
          // captureViewport invalidates the offscreen surface first. Electron
          // documents that this schedules a fresh paint; give Chromium's Viz
          // compositor a bounded chance to publish that frame before retrying.
          await delay(50 * (attempt + 1), signal)
        }
      }
      throw lastError
    }

    let clip: { x: number; y: number; width: number; height: number; scale: number }
    if (kind === 'element') {
      if (!target) throw new Error('An element screenshot requires a semantic target')
      const resolved = await this.resolveTarget(tab, target, false, signal)
      if (!resolved.backendNodeId) {
        throw new Error('Element screenshots require a semantic ref or role/name target')
      }
      const box = await this.elementBox(tab, resolved.backendNodeId, signal)
      clip = { ...box, scale: this.screenshotScale(box.width, box.height) }
    } else {
      const metrics = await abortable(
        tab.surface.sendDebuggerCommand<{
          contentSize?: { x?: number; y?: number; width: number; height: number }
          cssContentSize?: { x?: number; y?: number; width: number; height: number }
        }>('Page.getLayoutMetrics'),
        signal
      )
      const size = metrics.cssContentSize ?? metrics.contentSize
      if (!size) throw new Error('Unable to determine full-page screenshot dimensions')
      const width = Math.max(1, Math.min(MAX_SCREENSHOT_DIMENSION, Math.ceil(size.width)))
      const height = Math.max(1, Math.min(MAX_SCREENSHOT_DIMENSION, Math.ceil(size.height)))
      clip = {
        x: size.x ?? 0,
        y: size.y ?? 0,
        width,
        height,
        scale: this.screenshotScale(width, height)
      }
    }
    let png = Buffer.alloc(0)
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await abortable(
        tab.surface.sendDebuggerCommand<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          clip
        }),
        signal
      )
      png = Buffer.from(response.data, 'base64')
      if (png.byteLength <= MAX_MODEL_SCREENSHOT_BYTES) break
      clip.scale = Math.max(
        0.1,
        clip.scale * Math.min(0.8, Math.sqrt(MAX_MODEL_SCREENSHOT_BYTES / png.byteLength) * 0.9)
      )
    }
    if (!png.length) throw new Error('Chromium returned an empty screenshot')
    if (png.byteLength > MAX_MODEL_SCREENSHOT_BYTES) {
      throw new Error('Browser screenshot exceeds the 8 MiB vision input limit after downscaling')
    }
    return {
      png,
      width: Math.max(1, Math.round(clip.width * clip.scale)),
      height: Math.max(1, Math.round(clip.height * clip.scale))
    }
  }

  private screenshotScale(width: number, height: number): number {
    if (width * height <= MAX_SCREENSHOT_PIXELS) return 1
    return Math.max(0.1, Math.sqrt(MAX_SCREENSHOT_PIXELS / (width * height)))
  }

  private async enforceArtifactBounds(protectedPath: string, sessionRoot: string): Promise<void> {
    let release!: () => void
    const turn = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const previous = this.artifactTail.catch(() => undefined)
    this.artifactTail = previous.then(() => turn)
    await previous
    try {
      await this.pruneArtifactRoot(
        sessionRoot,
        protectedPath,
        Math.min(this.maxArtifacts, DEFAULT_MAX_ARTIFACTS_PER_SESSION),
        Math.min(this.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES_PER_SESSION)
      )
      await this.pruneArtifactRoot(
        this.artifactRoot,
        protectedPath,
        this.maxArtifacts,
        this.maxArtifactBytes
      )
    } finally {
      release()
    }
  }

  private async pruneArtifactRoot(
    root: string,
    protectedPath: string,
    maxArtifacts: number,
    maxArtifactBytes: number
  ): Promise<void> {
    const entries = await this.collectArtifacts(root)
    const now = this.now()
    for (const entry of entries) {
      if (entry.path === protectedPath) continue
      if (now - entry.mtimeMs > this.artifactRetentionMs) {
        await fs.unlink(entry.path).catch(() => undefined)
        entry.removed = true
      }
    }
    const retained = entries.filter((entry) => !entry.removed).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let bytes = retained.reduce((sum, entry) => sum + entry.size, 0)
    let count = retained.length
    for (const entry of retained) {
      if (count <= maxArtifacts && bytes <= maxArtifactBytes) break
      if (entry.path === protectedPath) continue
      await fs.unlink(entry.path).catch(() => undefined)
      bytes -= entry.size
      count--
    }
    const protectedEntry = retained.find((entry) => entry.path === protectedPath)
    if (
      protectedEntry &&
      (protectedEntry.size > maxArtifactBytes || count > maxArtifacts || bytes > maxArtifactBytes)
    ) {
      await fs.unlink(protectedPath).catch(() => undefined)
      throw new Error('Browser screenshot exceeds the configured artifact storage bound')
    }
  }

  private async collectArtifacts(
    root: string
  ): Promise<Array<{ path: string; size: number; mtimeMs: number; removed?: boolean }>> {
    const collected: Array<{ path: string; size: number; mtimeMs: number; removed?: boolean }> = []
    const visit = async (directory: string): Promise<void> => {
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile() && entry.name.endsWith('.png')) {
          const stat = await fs.stat(path)
          collected.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      }
    }
    await visit(root)
    return collected
  }

  private async ensureSemanticRefs(tab: TabState, signal?: AbortSignal): Promise<void> {
    if (!tab.refs.size) await this.captureSemanticSnapshot(tab, undefined, signal)
  }

  private async semanticRefForTarget(
    tab: TabState,
    target: BrowserTarget,
    signal?: AbortSignal
  ): Promise<SemanticRef> {
    await this.ensureSemanticRefs(tab, signal)
    if (target.ref) {
      const semanticRef = tab.refs.get(target.ref)
      if (!semanticRef || semanticRef.epoch !== tab.refEpoch) {
        throw new Error('Browser element ref is stale; observe the page again')
      }
      return semanticRef
    }
    if (!target.role && !target.name) {
      throw new Error('A semantic browser target needs a ref or accessible role/name')
    }
    const role = target.role?.toLowerCase()
    const exact = target.exact !== false
    let matches = tab.semanticNodes.filter((node) => {
      if (role && node.role !== role) return false
      if (target.name === undefined) return true
      return exact
        ? node.name === target.name
        : node.name.toLowerCase().includes(target.name.toLowerCase())
    })
    // A label such as "State" can appear on a heading, generic wrapper, and
    // combobox. Prefer a case-insensitive exact accessible-name match before a
    // broad substring match, then prefer roles appropriate to the requested
    // action. Refs remain the deterministic escape hatch.
    if (!exact && target.name !== undefined) {
      const normalizedName = target.name.toLowerCase()
      const exactNameMatches = matches.filter((node) => node.name.toLowerCase() === normalizedName)
      if (exactNameMatches.length) matches = exactNameMatches
    }
    if (!role && target.preferredRoles?.length && matches.length > 1) {
      const preferredRoles = new Set(target.preferredRoles.map((value) => value.toLowerCase()))
      const actionableMatches = matches.filter((node) => preferredRoles.has(node.role))
      // Action-specific roles remove headings and wrappers, but two genuinely
      // actionable controls with the same name must remain ambiguous. Silently
      // ranking one role above another can click a button instead of a checkbox.
      if (actionableMatches.length) matches = actionableMatches
    }
    const nth = target.nth
    if (nth !== undefined) {
      const index = boundedInteger(nth, 0, Math.max(0, matches.length - 1), 'target nth')
      if (!matches[index]) throw new Error('Semantic browser target was not found')
      return matches[index]
    }
    if (!matches.length) throw new Error('Semantic browser target was not found')
    if (matches.length > 1) {
      const candidates = matches
        .slice(0, 8)
        .map((node) => `${node.role} ${quoteSnapshot(node.name)} [ref=${node.ref}]`)
        .join('; ')
      throw new Error(
        `Semantic browser target is ambiguous (${matches.length} matches); use a ref or nth. Candidates: ${candidates}`
      )
    }
    return matches[0]
  }

  private async selectorBackendNode(
    tab: TabState,
    target: BrowserTarget,
    signal?: AbortSignal
  ): Promise<number> {
    const selector = target.selector?.trim()
    if (!selector) throw new Error('A non-empty CSS selector is required')
    if (selector.length > 2_000) throw new Error('CSS selector is too long')
    const document = await abortable(
      tab.surface.sendDebuggerCommand<{ root?: { nodeId?: number } }>('DOM.getDocument', {
        depth: 0,
        pierce: true
      }),
      signal
    )
    const nodeId = document.root?.nodeId
    if (!nodeId) throw new Error('Browser document is unavailable')
    const response = await abortable(
      tab.surface.sendDebuggerCommand<{ nodeIds?: number[] }>('DOM.querySelectorAll', {
        nodeId,
        selector
      }),
      signal
    )
    const nodeIds = response.nodeIds ?? []
    if (!nodeIds.length) throw new Error('CSS browser target was not found')
    let selectedNodeId: number
    if (target.nth !== undefined) {
      const index = boundedInteger(target.nth, 0, Math.max(0, nodeIds.length - 1), 'target nth')
      selectedNodeId = nodeIds[index]
    } else {
      if (nodeIds.length > 1) {
        throw new Error(`CSS browser target is ambiguous (${nodeIds.length} matches); use nth`)
      }
      selectedNodeId = nodeIds[0]
    }
    const described = await abortable(
      tab.surface.sendDebuggerCommand<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
        nodeId: selectedNodeId,
        depth: 0
      }),
      signal
    )
    if (!described.node?.backendNodeId) throw new Error('CSS browser target is no longer available')
    return described.node.backendNodeId
  }

  private async resolvedNodeObject(
    tab: TabState,
    backendNodeId: number,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await abortable(
      tab.surface.sendDebuggerCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId
      }),
      signal
    )
    const objectId = response.object?.objectId
    if (!objectId) throw new Error('Browser element is no longer available; observe again')
    return objectId
  }

  private async callOnNode<T>(
    tab: TabState,
    backendNodeId: number,
    functionDeclaration: string,
    args: unknown[] = [],
    signal?: AbortSignal
  ): Promise<T> {
    const objectId = await this.resolvedNodeObject(tab, backendNodeId, signal)
    try {
      const response = await abortable(
        tab.surface.sendDebuggerCommand<{
          result?: { value?: T; description?: string }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }),
        signal
      )
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text ??
            'Browser page evaluation failed'
        )
      }
      return response.result?.value as T
    } finally {
      await tab.surface
        .sendDebuggerCommand('Runtime.releaseObject', { objectId })
        .catch(() => undefined)
    }
  }

  private async elementRect(
    tab: TabState,
    backendNodeId: number,
    signal?: AbortSignal
  ): Promise<{
    x: number
    y: number
    pageX: number
    pageY: number
    width: number
    height: number
  }> {
    await abortable(
      tab.surface.sendDebuggerCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId }),
      signal
    ).catch(() => undefined)
    const rect = await this.callOnNode<{
      x: number
      y: number
      pageX: number
      pageY: number
      width: number
      height: number
    }>(
      tab,
      backendNodeId,
      `function() {
        const rect = this.getBoundingClientRect();
        return { x: rect.x, y: rect.y, pageX: rect.x + window.scrollX, pageY: rect.y + window.scrollY,
          width: rect.width, height: rect.height };
      }`,
      [],
      signal
    )
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Browser element is not visible')
    }
    return rect
  }

  private async elementBox(
    tab: TabState,
    backendNodeId: number,
    signal?: AbortSignal
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const rect = await this.elementRect(tab, backendNodeId, signal)
    return { x: rect.pageX, y: rect.pageY, width: rect.width, height: rect.height }
  }

  private async resolveTarget(
    tab: TabState,
    target: BrowserTarget,
    allowCoordinates: boolean,
    signal?: AbortSignal
  ): Promise<ElementPoint> {
    const hasSemantic = Boolean(target.ref || target.role || target.name)
    const hasSelector = Boolean(target.selector)
    let primaryError: unknown
    if (hasSemantic) {
      try {
        const semanticRef = await this.semanticRefForTarget(tab, target, signal)
        const rect = await this.elementRect(tab, semanticRef.backendNodeId, signal)
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          backendNodeId: semanticRef.backendNodeId,
          mode: target.ref ? 'ref' : 'semantic',
          fallbackUsed: false
        }
      } catch (error) {
        primaryError = error
      }
    }
    if (hasSelector) {
      try {
        const backendNodeId = await this.selectorBackendNode(tab, target, signal)
        const rect = await this.elementRect(tab, backendNodeId, signal)
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          backendNodeId,
          mode: 'selector',
          fallbackUsed: false
        }
      } catch (error) {
        primaryError = error
      }
    }
    if (!allowCoordinates || !target.coordinates) {
      if (primaryError) throw primaryError
      throw new Error('Browser action requires a ref, semantic target, or CSS selector')
    }
    if (!target.screenshotId) {
      throw new Error(
        'Browser coordinate actions require the screenshot_id from a current viewport observation'
      )
    }
    const screenshot = tab.lastViewportScreenshot
    if (!screenshot || screenshot.id !== target.screenshotId) {
      throw new Error(
        'Browser screenshot is stale; observe the viewport again before using coordinates'
      )
    }
    const currentCaptureState = await this.coordinateCaptureState(tab, signal)
    if (!this.sameCoordinateCaptureState(screenshot, currentCaptureState)) {
      throw new Error(
        'Browser screenshot is stale; observe the viewport again before using coordinates'
      )
    }
    const imageX = finiteCoordinate(target.coordinates.x, 'target x')
    const imageY = finiteCoordinate(target.coordinates.y, 'target y')
    if (imageX >= screenshot.imageWidth || imageY >= screenshot.imageHeight) {
      throw new Error('Browser coordinates are outside the referenced screenshot')
    }
    const x = (imageX * screenshot.viewportWidth) / screenshot.imageWidth
    const y = (imageY * screenshot.viewportHeight) / screenshot.imageHeight
    return { x, y, mode: 'coordinates', fallbackUsed: hasSemantic || hasSelector }
  }

  async click(
    input: BrowserClickInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'click', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, true, signal)
      const startedAt = this.now()
      this.setPointer(tab, target, 'click', startedAt)
      tab.surface.focus()
      const button = input.button ?? 'left'
      const clickCount = input.clickCount ?? 1
      tab.surface.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
      tab.surface.sendInputEvent({
        type: 'mouseDown',
        x: target.x,
        y: target.y,
        button,
        clickCount
      })
      tab.surface.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button, clickCount })
      return this.finishAction(
        session,
        tab,
        'click',
        target.mode,
        target.fallbackUsed,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  async hold(
    input: BrowserHoldInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const durationMs = boundedInteger(input.durationMs, MIN_HOLD_MS, MAX_HOLD_MS, 'hold duration')
      const fingerprint = canonicalFingerprint({
        action: 'hold',
        tabId: tab.id,
        input: { ...input, durationMs }
      })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, true, signal)
      // Press-and-hold is useful for ordinary canvas, map, slider, and test UI.
      // It is not an automated CAPTCHA solver; detected anti-bot checkpoints
      // always cross the same-session human-takeover boundary.
      const startedAt = this.now()
      this.setPointer(tab, target, 'hold', startedAt)
      tab.surface.focus()
      const button = input.button ?? 'left'
      tab.surface.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
      tab.surface.sendInputEvent({
        type: 'mouseDown',
        x: target.x,
        y: target.y,
        button,
        clickCount: 1
      })
      try {
        await delay(durationMs, signal)
      } finally {
        if (!tab.surface.isDestroyed()) {
          tab.surface.sendInputEvent({
            type: 'mouseUp',
            x: target.x,
            y: target.y,
            button,
            clickCount: 1
          })
        }
      }
      return this.finishAction(
        session,
        tab,
        'hold',
        target.mode,
        target.fallbackUsed,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  private async assertAutomatedMutationAllowed(tab: TabState, signal?: AbortSignal): Promise<void> {
    // This DOM/text probe is intentionally cheaper than another full CDP
    // accessibility snapshot. It gates every input/evaluation path, while the
    // post-action observation still produces the rich semantic state once.
    const challenge = await this.detectHumanVerification(tab, undefined, signal)
    if (challenge) throw new BrowserHumanVerificationError()
  }

  async type(
    input: BrowserTypeInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'type', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, true, signal)
      if (!target.backendNodeId) {
        throw new Error('Browser text entry requires a semantic or selector-backed field target')
      }
      const sourceUrl = tab.surface.getURL()
      const sourceRefEpoch = tab.refEpoch
      const startedAt = this.now()
      await this.clickFormControl(tab, target, signal)
      await this.assertTextEntryTarget(tab, target.backendNodeId, sourceUrl, sourceRefEpoch, signal)
      this.setPointer(tab, target, 'type', startedAt)
      if (input.clear !== false) {
        const selectAllModifier = process.platform === 'darwin' ? 'meta' : 'control'
        tab.surface.sendInputEvent({
          type: 'keyDown',
          keyCode: 'A',
          modifiers: [selectAllModifier]
        })
        tab.surface.sendInputEvent({
          type: 'keyUp',
          keyCode: 'A',
          modifiers: [selectAllModifier]
        })
        // Page key handlers can navigate or move focus. Cross a renderer
        // boundary and revalidate before the destructive clear key.
        await abortable(tab.surface.executeJavaScript('0'), signal)
        await this.assertTextEntryTarget(
          tab,
          target.backendNodeId,
          sourceUrl,
          sourceRefEpoch,
          signal
        )
        tab.surface.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
        tab.surface.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
        // sendInputEvent is fire-and-forget. Flush the clear keystrokes before
        // insertText, then prove the original field still owns focus so a page
        // handler cannot redirect sensitive text into another page or control.
        await abortable(tab.surface.executeJavaScript('0'), signal)
        await this.assertTextEntryTarget(
          tab,
          target.backendNodeId,
          sourceUrl,
          sourceRefEpoch,
          signal
        )
      }
      await abortable(tab.surface.insertText(input.text), signal)
      if (input.submit) this.sendKey(tab, 'Enter')
      // Electron input dispatch is asynchronous relative to later CDP capture.
      // A renderer round trip prevents the final character/key event from being
      // overtaken by post-action observation on busy offscreen renderers.
      await abortable(tab.surface.executeJavaScript('0'), signal)
      return this.finishAction(
        session,
        tab,
        'type',
        target.mode,
        target.fallbackUsed,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  private async inspectFormControl(
    tab: TabState,
    backendNodeId: number,
    signal?: AbortSignal
  ): Promise<BrowserFormControlState> {
    return this.callOnNode<BrowserFormControlState>(
      tab,
      backendNodeId,
      `function() {
        if (!this.isConnected) throw new Error('Target form control is no longer connected');
        const tag = String(this.tagName || '').toLowerCase();
        const inputType = tag === 'input' ? String(this.type || 'text').toLowerCase() : '';
        const disabled = this.disabled === true || this.getAttribute?.('aria-disabled') === 'true';
        const readOnly = this.readOnly === true || this.getAttribute?.('aria-readonly') === 'true';
        if (tag === 'select') {
          return {
            kind: 'select', disabled, readOnly: false,
            selectedValues: Array.from(this.selectedOptions || []).map(option => String(option.value))
          };
        }
        if (tag === 'input' && inputType === 'checkbox') {
          return { kind: 'checkbox', disabled, readOnly: false, checked: this.checked === true };
        }
        if (tag === 'input' && inputType === 'radio') {
          return { kind: 'radio', disabled, readOnly: false, checked: this.checked === true };
        }
        const unsupportedInputs = new Set(['button', 'submit', 'reset', 'file', 'hidden', 'image', 'range', 'color']);
        if ((tag === 'input' && !unsupportedInputs.has(inputType)) || tag === 'textarea') {
          return { kind: 'textbox', disabled, readOnly, value: String(this.value ?? '') };
        }
        if (this.isContentEditable === true) {
          return { kind: 'textbox', disabled, readOnly, value: String(this.textContent ?? '') };
        }
        return { kind: 'unsupported', disabled, readOnly };
      }`,
      [],
      signal
    )
  }

  private async replaceFormText(
    tab: TabState,
    target: ElementPoint,
    value: string,
    sourceUrl: string,
    sourceRefEpoch: number,
    signal?: AbortSignal
  ): Promise<void> {
    await this.clickFormControl(tab, target, signal)
    await this.assertTextEntryTarget(tab, target.backendNodeId!, sourceUrl, sourceRefEpoch, signal)
    this.setPointer(tab, target, 'type')
    const selectAllModifier = process.platform === 'darwin' ? 'meta' : 'control'
    tab.surface.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [selectAllModifier] })
    tab.surface.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [selectAllModifier] })
    await abortable(tab.surface.executeJavaScript('0'), signal)
    await this.assertTextEntryTarget(tab, target.backendNodeId!, sourceUrl, sourceRefEpoch, signal)
    tab.surface.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    tab.surface.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await abortable(tab.surface.executeJavaScript('0'), signal)
    await this.assertTextEntryTarget(tab, target.backendNodeId!, sourceUrl, sourceRefEpoch, signal)
    if (value) await abortable(tab.surface.insertText(value), signal)
    await abortable(tab.surface.executeJavaScript('0'), signal)
  }

  private async assertTextEntryTarget(
    tab: TabState,
    backendNodeId: number,
    sourceUrl: string,
    sourceRefEpoch: number,
    signal?: AbortSignal
  ): Promise<void> {
    const assertDocumentUnchanged = (): void => {
      if (tab.surface.getURL() !== sourceUrl || tab.refEpoch !== sourceRefEpoch) {
        throw new Error('Browser page changed before text entry; no text was inserted')
      }
    }
    assertDocumentUnchanged()
    await this.callOnNode<boolean>(
      tab,
      backendNodeId,
      `function() {
        if (!this.isConnected) throw new Error('Target text field is no longer connected');
        const tag = String(this.tagName || '').toLowerCase();
        const inputType = tag === 'input' ? String(this.type || 'text').toLowerCase() : '';
        const unsupportedInputs = new Set(['button', 'submit', 'reset', 'file', 'hidden', 'image', 'range', 'color', 'checkbox', 'radio']);
        const isTextbox = tag === 'textarea' || (tag === 'input' && !unsupportedInputs.has(inputType)) || this.isContentEditable === true;
        const active = document.activeElement;
        const ownsFocus = active === this || (this.isContentEditable === true && active && this.contains(active));
        if (!isTextbox || !ownsFocus) throw new Error('Target text field did not retain focus');
        return true;
      }`,
      [],
      signal
    )
    assertDocumentUnchanged()
  }

  private async updateFormSelect(
    tab: TabState,
    backendNodeId: number,
    values: string[],
    signal?: AbortSignal
  ): Promise<BrowserSelectMutationResult> {
    return this.callOnNode<BrowserSelectMutationResult>(
      tab,
      backendNodeId,
      `function(values) {
        if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
        if (!this.multiple && values.length !== 1) {
          throw new Error('A single-select field requires exactly one requested option');
        }
        const matched = values.map(requested => Array.from(this.options).filter(option =>
          option.value === requested || option.label === requested || option.text === requested
        ));
        if (matched.some(options => options.length !== 1)) {
          throw new Error('A requested select option was missing or ambiguous');
        }
        const selected = matched.map(options => options[0]);
        if (selected.some(option => option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))) {
          throw new Error('A requested select option is disabled');
        }
        const expectedValues = Array.from(new Set(selected.map(option => String(option.value))));
        const before = Array.from(this.selectedOptions).map(option => String(option.value));
        for (const option of this.options) option.selected = expectedValues.includes(String(option.value));
        const after = Array.from(this.selectedOptions).map(option => String(option.value));
        const changed = before.length !== after.length || before.some((value, index) => value !== after[index]);
        if (changed) {
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { changed, expectedValues };
      }`,
      [values],
      signal
    )
  }

  private async clickFormControl(
    tab: TabState,
    target: ElementPoint,
    signal?: AbortSignal
  ): Promise<void> {
    this.setPointer(tab, target, 'click')
    tab.surface.focus()
    tab.surface.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
    tab.surface.sendInputEvent({
      type: 'mouseDown',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    })
    tab.surface.sendInputEvent({
      type: 'mouseUp',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    })
    await abortable(tab.surface.executeJavaScript('0'), signal)
  }

  private formFieldFailure(error: unknown): BrowserFormFieldResult['error'] {
    const message = error instanceof Error ? error.message : String(error)
    if (/stale|not found|no longer available|ambiguous|not visible|requires a ref/i.test(message)) {
      return {
        code: 'target_not_found',
        message: 'The form field target could not be resolved from the current page state.'
      }
    }
    if (
      /not a select|requires exactly one|requested select options|unsupported|disabled|read-only/i.test(
        message
      )
    ) {
      return {
        code: 'unsupported_control',
        message: 'The target control does not support the requested form operation.'
      }
    }
    return {
      code: 'verification_failed',
      message: 'The requested form state could not be verified after the browser action.'
    }
  }

  async fillForm(
    input: BrowserFillFormInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserFillFormResult> {
    if (!Array.isArray(input.fields) || input.fields.length < 1) {
      throw new Error('Form fill requires at least one field')
    }
    if (input.fields.length > 25) throw new Error('Form fill supports at most 25 fields')
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'fill_form', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const startedAt = this.now()
      const initialUrl = tab.surface.getURL()
      const initialRefEpoch = tab.refEpoch
      const fields: BrowserFormFieldResult[] = []
      const sensitiveStrings = new Set<string>()
      let stopReason: BrowserFillFormResult['stopReason'] = 'completed'
      const pageChanged = (): boolean =>
        tab.surface.isDestroyed() ||
        session.activeTabId !== tab.id ||
        tab.surface.getURL() !== initialUrl ||
        tab.refEpoch !== initialRefEpoch

      for (let index = 0; index < input.fields.length; index++) {
        const field = input.fields[index]
        if (pageChanged()) {
          stopReason = 'page_changed'
          break
        }
        // A site may inject a challenge after an earlier field. Re-check at
        // each transaction boundary so the batch never drives a later field
        // through newly appeared human verification.
        await this.assertAutomatedMutationAllowed(tab, signal)
        let target: ElementPoint | undefined
        try {
          target = await this.resolveTarget(tab, field.target, false, signal)
          const backendNodeId = target.backendNodeId!
          const before = await this.inspectFormControl(tab, backendNodeId, signal)
          if (before.kind !== field.kind) {
            throw new Error('Target is an unsupported form control for the requested field kind')
          }
          if (before.disabled) throw new Error('Target form control is disabled')

          let status: BrowserFormFieldResult['status'] = 'unchanged'
          let verification: BrowserFormFieldResult['verification']
          if (field.kind === 'textbox') {
            sensitiveStrings.add(field.value)
            if (before.readOnly) throw new Error('Target form control is read-only')
            if (before.value !== field.value) {
              await this.replaceFormText(
                tab,
                target,
                field.value,
                initialUrl,
                initialRefEpoch,
                signal
              )
              status = 'filled'
            }
            if (pageChanged()) throw new Error('Browser page changed while filling the form')
            const after = await this.inspectFormControl(tab, backendNodeId, signal)
            const passed = after.kind === 'textbox' && after.value === field.value
            verification = { passed, valueLength: after.value?.length }
          } else if (field.kind === 'select') {
            for (const value of field.values) sensitiveStrings.add(value)
            if (!field.values.length || field.values.length > 20) {
              throw new Error('Select requires between one and 20 requested options')
            }
            const mutation = await this.updateFormSelect(tab, backendNodeId, field.values, signal)
            for (const value of mutation.expectedValues) sensitiveStrings.add(value)
            status = mutation.changed ? 'filled' : 'unchanged'
            if (pageChanged()) throw new Error('Browser page changed while filling the form')
            const after = await this.inspectFormControl(tab, backendNodeId, signal)
            const actual = [...(after.selectedValues ?? [])].sort()
            const expected = [...mutation.expectedValues].sort()
            const passed =
              after.kind === 'select' &&
              actual.length === expected.length &&
              actual.every((value, valueIndex) => value === expected[valueIndex])
            verification = { passed, selectedCount: actual.length }
            this.setPointer(tab, target, 'select')
          } else {
            if (field.kind === 'radio' && field.checked !== true) {
              throw new Error('A radio field can only be checked through real user input')
            }
            if (before.checked !== field.checked) {
              await this.clickFormControl(tab, target, signal)
              status = 'filled'
            }
            if (pageChanged()) throw new Error('Browser page changed while filling the form')
            const after = await this.inspectFormControl(tab, backendNodeId, signal)
            const passed = after.kind === field.kind && after.checked === field.checked
            verification = { passed }
          }

          if (!verification.passed) {
            fields.push({
              index,
              kind: field.kind,
              status: 'failed',
              targetMode: target.mode as BrowserFormFieldResult['targetMode'],
              verification,
              error: {
                code: 'verification_failed',
                message: 'The requested form state did not match the actual control state.'
              }
            })
            stopReason = 'field_failed'
            continue
          }
          fields.push({
            index,
            kind: field.kind,
            status,
            targetMode: target.mode as BrowserFormFieldResult['targetMode'],
            verification
          })
        } catch (error) {
          const changed = pageChanged()
          fields.push({
            index,
            kind: field.kind,
            status: 'failed',
            ...(target ? { targetMode: target.mode as BrowserFormFieldResult['targetMode'] } : {}),
            error: changed
              ? {
                  code: 'page_changed',
                  message: 'The page changed before this form field could be verified.'
                }
              : this.formFieldFailure(error)
          })
          stopReason = changed ? 'page_changed' : 'field_failed'
          if (changed) break
        }
      }

      for (let index = fields.length; index < input.fields.length; index++) {
        fields.push({ index, kind: input.fields[index].kind, status: 'skipped' })
      }

      const quiescence = await this.waitForQuiescence(tab, {}, signal)
      if (stopReason === 'completed' && pageChanged()) {
        stopReason = 'page_changed'
        const last = [...fields].reverse().find((field) => field.status !== 'skipped')
        if (last) {
          last.status = 'failed'
          last.error = {
            code: 'page_changed',
            message: 'The page changed before the completed form batch could be confirmed.'
          }
        }
      }
      const observation = redactFormObservation(
        await this.observeUnlocked(
          session,
          { tabId: tab.id, screenshot: 'none', includeSemanticSnapshot: true },
          signal
        ),
        sensitiveStrings
      )
      const changed = fields.some((field) => field.status === 'filled')
      tab.actionHistory.push({ fingerprint, changed })
      if (tab.actionHistory.length > 30) tab.actionHistory.splice(0, tab.actionHistory.length - 30)
      let unchangedRepeatCount = 0
      for (let index = tab.actionHistory.length - 1; index >= 0; index--) {
        const record = tab.actionHistory[index]
        if (record.fingerprint !== fingerprint || record.changed) break
        unchangedRepeatCount++
      }
      return {
        sessionId: session.id,
        tabId: tab.id,
        action: 'fill_form',
        completed: stopReason === 'completed',
        stopReason,
        attemptedFields: fields.filter((field) => field.status !== 'skipped').length,
        filledFields: fields.filter(
          (field) => field.status === 'filled' || field.status === 'unchanged'
        ).length,
        durationMs: this.now() - startedAt,
        quiescence,
        loopProtection: {
          unchangedRepeatCount,
          blockedOnNextIdenticalAction: unchangedRepeatCount >= this.maxRepeatedNoChangeActions
        },
        fields,
        observation
      }
    })
  }

  async select(
    input: BrowserSelectInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    if (!input.values.length) throw new Error('Select requires at least one value or label')
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'select', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, false, signal)
      const sourceUrl = tab.surface.getURL()
      const sourceRefEpoch = tab.refEpoch
      const semanticIdentity = target.backendNodeId
        ? tab.semanticNodes.find((node) => node.backendNodeId === target.backendNodeId)
        : undefined
      let verificationTarget: BrowserTarget
      if (target.mode === 'selector') {
        if (!input.target.selector) throw new Error('Resolved select selector is unavailable')
        verificationTarget = {
          selector: input.target.selector,
          ...(input.target.nth === undefined ? {} : { nth: input.target.nth })
        }
      } else {
        if (!semanticIdentity) throw new Error('Resolved select semantic identity is unavailable')
        verificationTarget = {
          role: semanticIdentity.role,
          name: semanticIdentity.name,
          exact: true
        }
      }
      const startedAt = this.now()
      this.setPointer(tab, target, 'select', startedAt)
      const expectedSelected = await this.callOnNode<string[]>(
        tab,
        target.backendNodeId!,
        `function(values) {
          if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
          if (!this.multiple && values.length > 1) {
            throw new Error('A single-select field accepts only one requested value');
          }
          const normalize = value => String(value).trim().replace(/\\s+/g, ' ').toLowerCase();
          const options = Array.from(this.options);
          const chosen = new Set();
          for (const requested of values) {
            const raw = String(requested);
            const normalized = normalize(raw);
            // Deterministic precedence matters when one option's value happens
            // to equal another option's label.
            let matches = options.filter(option => option.value === raw);
            if (!matches.length) {
              matches = options.filter(option => option.label === raw || option.text === raw);
            }
            if (!matches.length) {
              matches = options.filter(option =>
                [option.value, option.label, option.text].some(candidate => normalize(candidate) === normalized)
              );
            }
            if (!matches.length && normalized) {
              const partial = options.filter(option =>
                [option.value, option.label, option.text].some(candidate => {
                  const value = normalize(candidate);
                  return Boolean(value) && (value.startsWith(normalized) || normalized.startsWith(value));
                })
              );
              if (partial.length === 1) matches = partial;
            }
            if (matches.length !== 1) {
              const safe = value => String(value).trim().replace(/\\s+/g, ' ').slice(0, 80);
              const available = options.slice(0, 20).map(option => safe(option.label || option.text || option.value));
              const suffix = options.length > available.length ? ', ...' : '';
              throw new Error(matches.length
                ? 'A requested select value is ambiguous; use its exact option value. Candidates: ' + matches.slice(0, 8).map(option => safe(option.label || option.text || option.value)).join(', ')
                : 'No select option matched one requested value. Available options: ' + available.join(', ') + suffix);
            }
            chosen.add(matches[0]);
          }
          for (const option of options) {
            option.selected = chosen.has(option);
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return Array.from(this.selectedOptions).map(option => option.value);
        }`,
        [input.values],
        signal
      )
      const result = await this.finishAction(
        session,
        tab,
        'select',
        target.mode,
        false,
        fingerprint,
        startedAt,
        signal
      )
      if (result.observation.tab.url !== sourceUrl || tab.refEpoch !== sourceRefEpoch) {
        throw new Error(
          'Browser select changed the page before its final selection could be verified'
        )
      }
      const verificationNode = await this.resolveTarget(tab, verificationTarget, false, signal)
      const selectedAfterSettle = await this.callOnNode<string[]>(
        tab,
        verificationNode.backendNodeId!,
        `function() {
          if (!(this instanceof HTMLSelectElement) || !this.isConnected) {
            throw new Error('Target is no longer a connected select element');
          }
          return Array.from(this.selectedOptions).map(option => String(option.value));
        }`,
        [],
        signal
      )
      const expected = [...expectedSelected].sort()
      const actual = [...selectedAfterSettle].sort()
      if (
        expected.length !== actual.length ||
        expected.some((value, index) => value !== actual[index])
      ) {
        throw new Error(
          'Browser select did not retain the requested selection after page handlers ran'
        )
      }
      return result
    })
  }

  async press(
    input: BrowserPressInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'press', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = input.target
        ? await this.resolveTarget(tab, input.target, true, signal)
        : undefined
      const startedAt = this.now()
      if (target) this.setPointer(tab, target, 'press', startedAt)
      tab.surface.focus()
      if (target?.backendNodeId) {
        await this.callOnNode(tab, target.backendNodeId, `function() { this.focus(); }`, [], signal)
      } else if (target) {
        tab.surface.sendInputEvent({
          type: 'mouseDown',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: 1
        })
        tab.surface.sendInputEvent({
          type: 'mouseUp',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: 1
        })
      }
      this.sendKey(tab, input.key)
      return this.finishAction(
        session,
        tab,
        'press',
        target?.mode ?? 'page',
        target?.fallbackUsed ?? false,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  private sendKey(tab: TabState, key: string): void {
    const parts = key
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
    const keyCode = parts.pop()
    if (!keyCode) throw new Error('A keyboard key is required')
    const modifiers: Array<'shift' | 'control' | 'alt' | 'meta'> = []
    for (const modifier of parts) {
      const normalized = modifier.toLowerCase()
      if (normalized === 'ctrl' || normalized === 'control') modifiers.push('control')
      else if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta')
        modifiers.push('meta')
      else if (normalized === 'shift') modifiers.push('shift')
      else if (normalized === 'alt' || normalized === 'option') modifiers.push('alt')
      else throw new Error(`Unsupported keyboard modifier: ${modifier}`)
    }
    tab.surface.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    tab.surface.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  async scroll(
    input: BrowserScrollInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'scroll', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = input.target
        ? await this.resolveTarget(tab, input.target, true, signal)
        : undefined
      const startedAt = this.now()
      const deltaX = Number.isFinite(input.deltaX) ? input.deltaX! : 0
      if (!Number.isFinite(input.deltaY)) throw new Error('scroll deltaY must be finite')
      let scrollEffect: {
        before: { x: number; y: number }
        after: { x: number; y: number }
      }
      if (target?.backendNodeId) {
        this.setPointer(tab, target, 'scroll', startedAt)
        scrollEffect = await this.callOnNode(
          tab,
          target.backendNodeId,
          `function(dx, dy) {
            const before = { x: this.scrollLeft, y: this.scrollTop };
            this.scrollBy({ left: dx, top: dy, behavior: 'instant' });
            return { before, after: { x: this.scrollLeft, y: this.scrollTop } };
          }`,
          [deltaX, input.deltaY],
          signal
        )
      } else {
        const viewport = await this.currentViewport(tab)
        const point = target ?? {
          x: viewport.width / 2,
          y: viewport.height / 2,
          mode: 'page' as const,
          fallbackUsed: false
        }
        this.setPointer(tab, point, 'scroll', startedAt)
        scrollEffect = await abortable(
          tab.surface.executeJavaScript<{
            before: { x: number; y: number }
            after: { x: number; y: number }
          }>(`(() => {
            const before = { x: window.scrollX, y: window.scrollY };
            window.scrollBy({ left: ${JSON.stringify(deltaX)}, top: ${JSON.stringify(input.deltaY)}, behavior: 'instant' });
            return { before, after: { x: window.scrollX, y: window.scrollY } };
          })()`),
          signal
        )
      }
      const result = await this.finishAction(
        session,
        tab,
        'scroll',
        target?.mode ?? 'page',
        target?.fallbackUsed ?? false,
        fingerprint,
        startedAt,
        signal
      )
      const changed =
        scrollEffect.before.x !== scrollEffect.after.x ||
        scrollEffect.before.y !== scrollEffect.after.y
      result.effect = {
        changed,
        kind: 'scroll',
        before: scrollEffect.before,
        after: scrollEffect.after,
        ...(!changed
          ? {
              message:
                'Scroll had no effect at the current boundary. Target a scrollable element, reverse direction, or use a current semantic ref instead of repeating it.'
            }
          : {})
      }
      return result
    })
  }

  async resize(
    input: BrowserResizeInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const viewport = this.normalizeViewport(input.viewport)
      const fingerprint = canonicalFingerprint({ action: 'resize', tabId: tab.id, viewport })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      const startedAt = this.now()
      tab.lastPointer = undefined
      tab.surface.resizeViewport(viewport)
      await abortable(
        tab.surface.sendDebuggerCommand('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
          mobile: false,
          screenWidth: viewport.width,
          screenHeight: viewport.height,
          scale: 1
        }),
        signal
      )
      this.invalidateSemanticRefs(tab)
      return this.finishAction(
        session,
        tab,
        'resize',
        'page',
        false,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  async hover(
    input: BrowserHoverInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'hover', tabId: tab.id, input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, true, signal)
      const startedAt = this.now()
      this.setPointer(tab, target, 'hover', startedAt)
      tab.surface.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
      return this.finishAction(
        session,
        tab,
        'hover',
        target.mode,
        target.fallbackUsed,
        fingerprint,
        startedAt,
        signal
      )
    })
  }

  private async mutationRevision(tab: TabState, signal?: AbortSignal): Promise<number> {
    return abortable(
      tab.surface.executeJavaScript<number>(`(() => {
        const key = Symbol.for('io.sidekick.browser.mutation-state');
        let state = window[key];
        if (!state) {
          state = { revision: 0 };
          const observer = new MutationObserver(() => state.revision++);
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          state.observer = observer;
          window[key] = state;
        }
        return state.revision;
      })()`),
      signal
    )
  }

  private async coordinateCaptureState(
    tab: TabState,
    signal?: AbortSignal
  ): Promise<CoordinateCaptureState> {
    const state = await abortable(
      tab.surface.executeJavaScript<{
        sourceUrl: string
        viewportWidth: number
        viewportHeight: number
        scrollX: number
        scrollY: number
        mutationRevision: number
      }>(`(() => {
        // io.sidekick.browser.coordinate-capture-state
        const key = Symbol.for('io.sidekick.browser.mutation-state');
        let mutationState = window[key];
        if (!mutationState) {
          mutationState = { revision: 0 };
          const observer = new MutationObserver(() => mutationState.revision++);
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          mutationState.observer = observer;
          window[key] = mutationState;
        }
        return {
          sourceUrl: location.href,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          mutationRevision: mutationState.revision
        };
      })()`),
      signal
    )
    if (
      !state ||
      typeof state.sourceUrl !== 'string' ||
      !Number.isFinite(state.viewportWidth) ||
      !Number.isFinite(state.viewportHeight) ||
      state.viewportWidth < 1 ||
      state.viewportHeight < 1 ||
      !Number.isFinite(state.scrollX) ||
      !Number.isFinite(state.scrollY) ||
      !Number.isFinite(state.mutationRevision)
    ) {
      throw new Error('Unable to bind browser coordinates to the current viewport state')
    }
    return { ...state, refEpoch: tab.refEpoch }
  }

  private sameCoordinateCaptureState(
    left: CoordinateCaptureState,
    right: CoordinateCaptureState
  ): boolean {
    return (
      left.sourceUrl === right.sourceUrl &&
      left.refEpoch === right.refEpoch &&
      left.viewportWidth === right.viewportWidth &&
      left.viewportHeight === right.viewportHeight &&
      left.scrollX === right.scrollX &&
      left.scrollY === right.scrollY &&
      left.mutationRevision === right.mutationRevision
    )
  }

  private pendingRequests(tab: TabState): number {
    let pending = 0
    for (const request of tab.inFlight.values()) {
      if (!request.ignoredForIdle && this.now() - request.startedAt < 2_000) pending++
    }
    return pending
  }

  private setPointer(
    tab: TabState,
    target: Pick<ElementPoint, 'x' | 'y' | 'mode'>,
    action: BrowserPointer['action'],
    updatedAt = this.now()
  ): void {
    tab.lastPointer = {
      x: target.x,
      y: target.y,
      action,
      targetMode: target.mode,
      updatedAt
    }
  }

  private async waitForQuiescence(
    tab: TabState,
    input: { idleMs?: number; maxWaitMs?: number },
    signal?: AbortSignal
  ): Promise<BrowserQuiescenceResult> {
    const idleMs = boundedInteger(input.idleMs ?? 350, 50, 5_000, 'idleMs')
    const maxWaitMs = boundedInteger(input.maxWaitMs ?? 5_000, idleMs, 30_000, 'maxWaitMs')
    const startedAt = this.now()
    let stableSince = startedAt
    let revision = await this.mutationRevision(tab, signal).catch(() => 0)
    while (this.now() - startedAt < maxWaitMs) {
      const nextRevision = await this.mutationRevision(tab, signal).catch(() => revision)
      const pending = this.pendingRequests(tab)
      if (nextRevision !== revision || pending > 0 || tab.surface.isLoading()) {
        revision = nextRevision
        stableSince = this.now()
      } else if (this.now() - stableSince >= idleMs) {
        return {
          idle: true,
          waitedMs: this.now() - startedAt,
          pendingRequests: pending,
          mutationRevision: revision,
          timedOut: false
        }
      }
      await delay(50, signal)
    }
    return {
      idle: false,
      waitedMs: this.now() - startedAt,
      pendingRequests: this.pendingRequests(tab),
      mutationRevision: revision,
      timedOut: true
    }
  }

  private async ensureBaselineHash(
    _session: SessionState,
    tab: TabState,
    signal?: AbortSignal
  ): Promise<void> {
    if (tab.lastScreenshotHashes.viewport) return
    const capture = await this.captureRaw(tab, 'viewport', undefined, signal)
    tab.lastScreenshotHashes.viewport = createHash('sha256').update(capture.png).digest('hex')
  }

  private guardRepeatedAction(tab: TabState, fingerprint: string): void {
    let repeats = 0
    for (let index = tab.actionHistory.length - 1; index >= 0; index--) {
      const record = tab.actionHistory[index]
      if (record.fingerprint !== fingerprint || record.changed) break
      repeats++
    }
    if (repeats >= this.maxRepeatedNoChangeActions) {
      const error = new Error(
        `Browser loop protection blocked an identical action after ${repeats} unchanged attempts`
      ) as Error & { code?: string }
      error.name = 'BrowserLoopError'
      error.code = 'BROWSER_REPEATED_NO_CHANGE'
      throw error
    }
  }

  private async finishAction(
    session: SessionState,
    tab: TabState,
    action: string,
    targetMode: BrowserActionResult['targetMode'],
    fallbackUsed: boolean,
    fingerprint: string,
    startedAt: number,
    signal?: AbortSignal,
    settledQuiescence?: BrowserQuiescenceResult
  ): Promise<BrowserActionResult> {
    const quiescence = settledQuiescence ?? (await this.waitForQuiescence(tab, {}, signal))
    const observation = await this.observeUnlocked(
      session,
      { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
      signal
    )
    const changed = observation.screenshotChanged !== false
    tab.actionHistory.push({ fingerprint, changed })
    if (tab.actionHistory.length > 30) tab.actionHistory.splice(0, tab.actionHistory.length - 30)
    let unchangedRepeatCount = 0
    for (let index = tab.actionHistory.length - 1; index >= 0; index--) {
      const record = tab.actionHistory[index]
      if (record.fingerprint !== fingerprint || record.changed) break
      unchangedRepeatCount++
    }
    return {
      sessionId: session.id,
      tabId: tab.id,
      action,
      targetMode,
      coordinateFallbackUsed: fallbackUsed,
      durationMs: this.now() - startedAt,
      quiescence,
      loopProtection: {
        unchangedRepeatCount,
        blockedOnNextIdenticalAction: unchangedRepeatCount >= this.maxRepeatedNoChangeActions
      },
      observation
    }
  }

  async wait(
    input: BrowserWaitInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserObservation> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const condition = input.condition ?? { type: 'quiescence' as const }
      if (condition.type === 'quiescence') {
        await this.waitForQuiescence(tab, condition, signal)
      } else if (condition.type === 'time') {
        await delay(boundedInteger(condition.ms, 0, 60_000, 'wait duration'), signal)
      } else {
        await this.waitForCondition(tab, condition, signal)
      }
      return this.observeUnlocked(
        session,
        { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
        signal
      )
    })
  }

  private async waitForCondition(
    tab: TabState,
    condition: Exclude<BrowserWaitCondition, { type: 'quiescence' } | { type: 'time' }>,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = this.now()
    while (this.now() - startedAt < 10_000) {
      let satisfied = false
      if (condition.type === 'text') {
        const present = await abortable(
          tab.surface.executeJavaScript<boolean>(
            `document.body ? document.body.innerText.includes(${JSON.stringify(condition.text)}) : false`
          ),
          signal
        )
        satisfied = (condition.state ?? 'present') === 'present' ? present : !present
      } else if (condition.type === 'url') {
        satisfied = matchesText(this.tabUrl(tab), condition.value, condition.match)
      } else {
        try {
          await this.captureSemanticSnapshot(tab, undefined, signal)
          await this.resolveTarget(tab, condition.target, false, signal)
          satisfied = (condition.state ?? 'present') === 'present'
        } catch {
          satisfied = (condition.state ?? 'present') === 'absent'
        }
      }
      if (satisfied) return
      await delay(100, signal)
    }
    throw timeoutError(`Browser wait condition was not met: ${condition.type}`)
  }

  async tabs(
    input: BrowserTabsInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserTabsResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const action = input.action ?? 'list'
      if (action === 'list') {
        return {
          sessionId: session.id,
          activeTabId: session.activeTabId,
          tabs: this.tabSummaries(session)
        }
      }
      if (action === 'new') {
        const url = input.url
          ? await this.normalizeNavigationUrl(input.url, session.allowedFileRoots)
          : undefined
        const viewport = await this.currentViewport(this.getTab(session))
        const tab = await this.createOwnedTab(session, viewport, signal)
        session.activeTabId = tab.id
        try {
          if (url) await this.navigateUnlocked(session, tab, url, signal)
          const observation = await this.observeUnlocked(
            session,
            { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
            signal
          )
          return {
            sessionId: session.id,
            activeTabId: tab.id,
            tabs: this.tabSummaries(session),
            observation
          }
        } catch (error) {
          await this.closeTab(session, tab)
          throw error
        }
      }
      const tab = this.getTab(session, input.tabId)
      if (action === 'select') {
        session.activeTabId = tab.id
        const observation = await this.observeUnlocked(
          session,
          { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
          signal
        )
        return {
          sessionId: session.id,
          activeTabId: tab.id,
          tabs: this.tabSummaries(session),
          observation
        }
      }
      await this.closeTab(session, tab)
      const active = session.activeTabId ? this.getTab(session) : undefined
      const observation = active
        ? await this.observeUnlocked(
            session,
            { tabId: active.id, screenshot: 'viewport', includeSemanticSnapshot: true },
            signal
          )
        : undefined
      return {
        sessionId: session.id,
        activeTabId: session.activeTabId,
        tabs: this.tabSummaries(session),
        observation
      }
    })
  }

  private async closeTab(session: SessionState, tab: TabState): Promise<void> {
    for (const token of tab.pdfSessionTokens) revokeBrowserPdfSession(token)
    tab.pdfSessionTokens.clear()
    for (const dispose of tab.disposers.splice(0)) dispose()
    session.tabs.delete(tab.id)
    if (session.activeTabId === tab.id) session.activeTabId = session.tabs.keys().next().value ?? ''
    await tab.surface.close()
    if (!session.tabs.size) {
      revokeBrowserPdfSessionsByOwner(session.id)
      this.sessions.delete(session.id)
    }
  }

  async console(
    input: BrowserTelemetryInput,
    operation: BrowserOperationOptions = {}
  ): Promise<{ entries: BrowserConsoleEntry[]; cursor: number }> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async () => {
      const tab = input.tabId ? this.getTab(session, input.tabId) : undefined
      const after = Math.max(0, Math.trunc(input.afterSequence ?? 0))
      return {
        entries: session.console.filter(
          (entry) => entry.sequence > after && (!tab || entry.tabId === tab.id)
        ),
        cursor: session.consoleSequence
      }
    })
  }

  async network(
    input: BrowserTelemetryInput,
    operation: BrowserOperationOptions = {}
  ): Promise<{ failures: BrowserNetworkFailure[]; cursor: number }> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async () => {
      const tab = input.tabId ? this.getTab(session, input.tabId) : undefined
      const after = Math.max(0, Math.trunc(input.afterSequence ?? 0))
      return {
        failures: session.failures.filter(
          (entry) => entry.sequence > after && (!tab || entry.tabId === tab.id)
        ),
        cursor: session.networkSequence
      }
    })
  }

  async evaluate(
    input: BrowserEvaluateInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserEvaluateResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const envelope = await abortable(
        tab.surface.executeJavaScript<{ json: string; truncated: boolean }>(`(async () => {
          let value = await (0, eval)(${JSON.stringify(input.expression)});
          if (value === undefined) value = null;
          const seen = new WeakSet();
          let json = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return item.toString();
            if (typeof item === 'object' && item !== null) {
              if (seen.has(item)) return '[Circular]';
              seen.add(item);
            }
            return item;
          });
          if (json === undefined) json = 'null';
          const limit = ${MAX_EVALUATION_BYTES};
          const truncated = json.length > limit;
          return { json: truncated ? json.slice(0, limit) : json, truncated };
        })()`),
        signal
      )
      let value: unknown = envelope.json
      if (!envelope.truncated) {
        try {
          value = JSON.parse(envelope.json)
        } catch {
          value = envelope.json
        }
      }
      return {
        sessionId: session.id,
        tabId: tab.id,
        value,
        serializedBytes: Buffer.byteLength(envelope.json, 'utf8'),
        truncated: envelope.truncated
      }
    })
  }

  async verify(
    input: BrowserVerifyInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserVerificationResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const observation = await this.observeUnlocked(
        session,
        { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
        signal
      )
      const results: BrowserVerificationResult['assertions'] = []
      for (const assertion of input.assertions) {
        let passed = false
        let actual: string | undefined
        if (assertion.type === 'url') {
          actual = this.tabUrl(tab)
          passed = matchesText(actual, assertion.value, assertion.match)
        } else if (assertion.type === 'title') {
          actual = tab.surface.getTitle()
          passed = matchesText(actual, assertion.value, assertion.match)
        } else if (assertion.type === 'text') {
          const present = await abortable(
            tab.surface.executeJavaScript<boolean>(
              `document.body ? document.body.innerText.includes(${JSON.stringify(assertion.text)}) : false`
            ),
            signal
          )
          actual = present ? 'present' : 'absent'
          passed = (assertion.state ?? 'present') === actual
        } else if (assertion.type === 'semantic') {
          let present = false
          try {
            await this.resolveTarget(tab, assertion.target, false, signal)
            present = true
          } catch {
            present = false
          }
          actual = present ? 'present' : 'absent'
          passed = (assertion.state ?? 'present') === actual
        } else {
          actual = observation.screenshot?.sha256
          const changed = actual !== assertion.baselineSha256
          passed = changed === (assertion.changed ?? true)
        }
        results.push({ ...assertion, passed, actual })
      }
      return {
        passed: results.every((assertion) => assertion.passed),
        assertions: results,
        observation
      }
    })
  }

  async beginHumanTakeover(
    sessionId: string,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserHumanTakeoverResult> {
    const session = this.getSession(sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session)
      session.humanTakeoverTabId = tab.id
      try {
        tab.surface.showForHumanTakeover()
        const observation = await this.observeUnlocked(
          session,
          { tabId: tab.id, screenshot: 'none', includeSemanticSnapshot: true },
          signal
        )
        return {
          active: tab.surface.isHumanTakeoverVisible(),
          observation
        }
      } catch (error) {
        tab.surface.hideHumanTakeover()
        session.humanTakeoverTabId = undefined
        throw error
      }
    })
  }

  async completeHumanTakeover(
    sessionId: string,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserHumanTakeoverResult> {
    const session = this.getSession(sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      if (!session.humanTakeoverTabId) throw new Error('Human browser takeover is not active')
      const tab = this.getTab(session, session.humanTakeoverTabId)
      tab.surface.hideHumanTakeover()
      session.humanTakeoverTabId = undefined
      this.invalidateSemanticRefs(tab)
      await this.waitForQuiescence(tab, { idleMs: 200, maxWaitMs: 2_000 }, signal)
      return {
        active: false,
        observation: await this.observeUnlocked(
          session,
          { tabId: tab.id, screenshot: 'viewport', includeSemanticSnapshot: true },
          signal
        )
      }
    })
  }

  async close(
    input: BrowserCloseInput
  ): Promise<{ closedSessions: string[]; closedTabs: string[] }> {
    if (!input.sessionId && !input.runId) {
      throw new Error('browser close requires a sessionId or runId')
    }
    const sessions = input.sessionId
      ? [this.getSession(input.sessionId)]
      : [...this.sessions.values()].filter((session) => session.runId === input.runId)
    const closedSessions: string[] = []
    const closedTabs: string[] = []
    for (const session of sessions) {
      if (input.tabId) {
        const tab = this.getTab(session, input.tabId)
        closedTabs.push(tab.id)
        await this.closeTab(session, tab)
        if (input.deleteArtifacts) await this.deleteTabArtifacts(session, tab.id)
      } else {
        for (const tab of [...session.tabs.values()]) {
          closedTabs.push(tab.id)
          await this.closeTab(session, tab)
        }
        this.sessions.delete(session.id)
        closedSessions.push(session.id)
        if (input.deleteArtifacts) await this.deleteSessionArtifacts(session)
      }
    }
    return { closedSessions, closedTabs }
  }

  private async deleteSessionArtifacts(session: SessionState): Promise<void> {
    const directory = join(this.artifactRoot, safeSegment(session.runId), safeSegment(session.id))
    await this.deleteArtifactDirectory(directory)
  }

  private async deleteTabArtifacts(session: SessionState, tabId: string): Promise<void> {
    const directory = join(
      this.artifactRoot,
      safeSegment(session.runId),
      safeSegment(session.id),
      safeSegment(tabId)
    )
    await this.deleteArtifactDirectory(directory)
  }

  private async deleteArtifactDirectory(directory: string): Promise<void> {
    if (!isPathWithin(this.artifactRoot, directory) || directory === this.artifactRoot) {
      throw new Error('Refusing to remove an unsafe browser artifact path')
    }
    let stat: import('fs').Stats
    try {
      stat = await fs.lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) {
      await fs.unlink(directory)
      return
    }
    const [realRoot, realDirectory] = await Promise.all([
      fs.realpath(this.artifactRoot),
      fs.realpath(directory)
    ])
    if (!isPathWithin(realRoot, realDirectory) || realDirectory === realRoot) {
      throw new Error('Refusing to remove an artifact directory outside the canonical root')
    }
    await fs.rm(directory, { recursive: true, force: true })
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      for (const tab of [...session.tabs.values()]) await this.closeTab(session, tab)
      this.sessions.delete(session.id)
    }
  }
}
