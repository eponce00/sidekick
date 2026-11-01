import type { BrowserDeviceState } from '../../shared/browserDevices'
import type { BrowserCertificateNotice } from '../../shared/browserWorkspace'
import { browserNetworkOrigin, loopbackHost, privateNetworkHost } from '../../shared/browserNetwork'
import { getDomain } from 'tldts'
import { credentialPageOrigin } from '../../shared/credentials'
import type { BrowserNetworkPolicy } from './browserNetworkApprovals'
import {
  BrowserCertificateError,
  certificateAllowed,
  certificateNotice,
  type BrowserCertificateEvent,
  type BrowserCertificateFailure,
  type BrowserCertificatePolicy
} from './browserCertificatePolicy'
import { createHash, randomUUID } from 'crypto'
import { browserTextTargetOwnsFocus } from './browserTextFocus'
import { locateWorkspacePath, resolveSecureWorkspacePath } from '../utils/workspacePaths'
import { atomicNewFile } from '../utils/atomicNewFile'
import { capturePublicationDirectory } from '../utils/publicationDirectory'
import { promises as fs, realpathSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { enterBrowserText, type BrowserTextEntryDriver } from './browserTextEntry'
import {
  captureBrowserScreenshot,
  MAX_MODEL_SCREENSHOT_BYTES,
  type BrowserCaptureBox,
  type BrowserLayoutMetrics
} from './browserScreenshotCapture'
import {
  browserViewHost,
  registerBrowserView,
  parkBrowserView,
  browserAgentInput,
  browserDebuggerCommand,
  browserNavigationState,
  browserViewLayoutSettled,
  showBrowserPointer,
  setBrowserViewAgentViewport,
  type BrowserViewportFit
} from './browserViewHost'
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
import { externalSchemaIssues } from './agentToolRegistry'
import {
  busyRequests,
  SETTLE_INSTALL_SCRIPT,
  SETTLE_MARK_SCRIPT,
  settleProbeScript
} from './browserSettle'
import {
  foldChoiceText,
  PICKER_PAGE_FUNCTION,
  rankChoices,
  showsChoice,
  type PickerKind,
  type PickerOption,
  type PickerScan
} from './browserPicker'
import { fieldDateFormat, formatDate, nativeDateFormat, sameEnteredText } from './browserDates'
import {
  WEBMCP_CALL_TIMEOUT_MS,
  WEBMCP_COMPATIBILITY_SCRIPT,
  WebMcpCallError,
  WebMcpPageTools,
  type WebMcpCallOutcome,
  type WebMcpPageListing,
  type WebMcpTool
} from './webMcpPageTools'

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
  /** A site-owned anti-bot checkpoint only the user can clear, in the Browser panel. */
  humanVerification?: BrowserHumanVerification | null
  screenshot?: BrowserScreenshotArtifact
  /** Capture failed transiently; no image was observed. The page remains usable. */
  screenshotError?: string
  screenshotChanged: boolean | null
  unchangedScreenshotStreak: number
  console: BrowserConsoleEntry[]
  failedRequests: BrowserNetworkFailure[]
  cursors: { console: number; network: number }
  /** Names of the WebMCP tools the page offers, when it offers any. */
  webMcpTools?: string[]
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
  /** Ordered fields. Independent fields continue after a field error; page changes stop the batch. */
  fields: BrowserFormFieldInput[]
}

/** A stored sign-in to fill on the current page, which must be on `site`. */
export interface BrowserSignInInput {
  sessionId: string
  /** Found on the page, as a password manager finds them, when absent. */
  usernameTarget?: BrowserTarget
  passwordTarget?: BrowserTarget
  username?: string
  password?: string
  /** The origin the use was approved for. Its form may send only to the same site. */
  site: string
  submit?: boolean
}

/**
 * The registrable domain of an HTTPS sign-in site, such as example.com for login.example.com, or
 * null for an address or a server on this computer, where only the exact origin counts.
 */
export function signInDomain(site: string): string | null {
  const url = new URL(site)
  if (url.protocol !== 'https:' || url.port) return null
  return getDomain(url.hostname, { allowPrivateDomains: true })
}

/** A sign-in form may send to its own origin, or over HTTPS to another site of the same domain. */
export function sameSignInSite(site: string, domain: string | null, target: string): boolean {
  if (target === site) return true
  if (!domain) return false
  const url = new URL(target)
  return (
    url.protocol === 'https:' &&
    !url.port &&
    (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  )
}

export interface BrowserSignInResult extends BrowserActionResult {
  action: 'sign_in'
  origin: string
  filled: Array<'username' | 'password'>
  submitted: boolean
}

/** What a sign-in checks about a field before putting anything in it. */
interface SignInFieldFacts {
  connected: boolean
  tag: string
  type: string
  topFrame: boolean
  origin: string
  formOrigin: string | null
  disabled: boolean
  readOnly: boolean
}

/**
 * Finds the fields of a sign-in form in the top document, as a password manager does: a visible
 * password field, and the username field in its form, by autocomplete hint, name, or position.
 * With no password field, as on the first step of a two-step sign-in, a lone username field.
 */
const FIND_SIGN_IN_FIELD = `(kind) => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.disabled;
  };
  const passwords = Array.from(document.querySelectorAll('input[type="password" i]')).filter(visible);
  const password = passwords.find((field) => !/new-password/i.test(field.autocomplete || '')) || passwords[0] || null;
  if (kind === 'password') return password;
  const scope = (password && password.form) || document;
  const candidates = Array.from(scope.querySelectorAll('input')).filter((field) =>
    visible(field) && ['', 'text', 'email', 'tel'].includes(String(field.getAttribute('type') || '').toLowerCase()));
  const hinted = candidates.find((field) => /username|email/i.test(field.autocomplete || '')) ||
    candidates.find((field) => /user|login|email|account|identifier/i.test((field.name || '') + ' ' + (field.id || '')));
  if (hinted) return hinted;
  if (password) {
    const before = candidates.filter((field) => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}`

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
  /** Phones and tablets: mobile layout, touch, and a mobile user agent. */
  emulation?: { mobile: boolean; tablet?: boolean }
  /** What to call this size and who chose it; explicit dimensions default to the agent. */
  device?: Omit<BrowserDeviceState, 'width' | 'height'>
}

/** Chrome on Android, at this Chromium's version; tablets omit "Mobile", as Chrome does. */
function mobileUserAgent(tablet: boolean): string {
  const chrome = process.versions.chrome ?? '130.0.0.0'
  return tablet
    ? `Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
    : `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`
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

/**
 * What a call to a page's tool was checked against before anyone was asked: the tab, its document
 * and the tool as it stood. A call made under it is refused if any of them changed since.
 */
export interface WebMcpCallBinding {
  tabId: string
  document: number
  origin: string
  tool: WebMcpTool
}

export interface BrowserWebMcpCallInput {
  sessionId: string
  /** The site the caller means to act on; the call is refused on any other. */
  origin: string
  tool: string
  arguments: Record<string, unknown>
  binding?: WebMcpCallBinding
}

export interface BrowserWebMcpCallResult {
  sessionId: string
  tabId: string
  origin: string
  tool: Pick<
    WebMcpTool,
    'name' | 'readOnly' | 'untrustedContent' | 'consequential' | 'form' | 'autosubmit'
  >
  outcome: WebMcpCallOutcome
  durationMs: number
  page: { url: string; title: string }
}

export interface BrowserCloseInput {
  sessionId?: string
  runId?: string
  tabId?: string
  deleteArtifacts?: boolean
}

export interface NativeBrowserSessionServiceOptions {
  artifactRoot: string
  /** Destination for filled copies of PDFs opened from remote URLs. */
  pdfOutputRoot?: string
  allowedFileRoots?: string[]
  allowedAttachWebContentsIds?: ReadonlySet<number>
  canAttachWebContents?: (webContentsId: number, currentUrl: string) => boolean
  maxSessionsPerRun?: number
  maxTotalSessions?: number
  maxTabsPerSession?: number
  maxArtifacts?: number
  maxArtifactBytes?: number
  maxRemotePdfBytes?: number
  /** Which local-network origins may be opened over plain HTTP; none without it. */
  networkPolicy?: BrowserNetworkPolicy
  /** Which untrusted certificates a tab may go on past; none without it. */
  certificatePolicy?: BrowserCertificatePolicy
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
  /** Fetch through this tab's isolated Chromium session, preserving its cookie/network context. */
  fetch(url: string, init?: RequestInit): Promise<Response>
  stop(): void
  close(): Promise<void>
  focus(): void
  insertText(text: string): Promise<void>
  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void
  /** Shows the agent's cursor at a CSS viewport point to whoever watches the page. */
  showPointer?(x: number, y: number): void
  resizeViewport(viewport: BrowserViewport): void
  /**
   * Lays the page out at exactly this viewport, whatever the size and zoom of where it is shown;
   * a page shown in the app is drawn scaled down to fit.
   */
  setAgentViewport?(viewport: BrowserViewport, options?: BrowserEmulationOptions): Promise<void>
  /** Returns the page to the size of where it is shown, with its own user agent and input. */
  clearAgentViewport?(): Promise<void>
  executeJavaScript<T>(source: string): Promise<T>
  captureViewport(): Promise<NativeBrowserSurfaceCapture>
  attachDebugger(): Promise<void>
  detachDebugger(): void
  sendDebuggerCommand<T>(method: string, params?: Record<string, unknown>): Promise<T>
  setNavigationGuard(guard: (url: string) => boolean): void
  /** Guards file:// document and subresource requests in the isolated partition. */
  setRequestGuard(guard: (url: string) => boolean): void
  /** Answers each connection this tab's isolated session would refuse for its certificate. */
  setCertificateGuard(guard: (event: BrowserCertificateEvent) => boolean): void
  /** Ends this tab's session's open connections, so the next request is judged afresh. */
  closeConnections?(): Promise<void>
  onConsole(listener: (message: NativeBrowserSurfaceConsoleMessage) => void): () => void
  onLoadFailure(listener: (failure: NativeBrowserSurfaceLoadFailure) => void): () => void
  onDebuggerMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void
  onDestroyed(listener: () => void): () => void
  onOpenUrl(listener: (url: string) => void): () => void
}

/** How a fixed viewport presents itself: a phone or tablet is mobile, touch, and says so. */
export interface BrowserEmulationOptions {
  mobile?: boolean
  userAgent?: string
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
  /** The certificate refused for the page this tab tried to open last. */
  certificate?: BrowserCertificateFailure
  /** A fixed viewport in effect, and who chose it; absent while the page is responsive. */
  device?: BrowserDeviceState
  /** User-facing source URL when the WebContents is showing an internal viewer. */
  logicalUrl?: string
  pdfSessionToken?: string
  pdfSessionTokens: Set<string>
  temporaryPdfSources: Set<string>
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
  /** Where the latest action began, so its wait counts only what the action changed. */
  settleMark?: { token: string; id: string; at: number }
  actionHistory: ActionRecord[]
  disposers: Array<() => void>
  /**
   * Password fields a stored sign-in filled on the current document. While one still holds its
   * value, screenshots are withheld if it stops being a password field, and evaluation is refused.
   */
  secretFields?: number[]
  /** The WebMCP tools the tab's top-level document offers. */
  webMcp: WebMcpPageTools
}

interface OpeningReservation {
  runId: string
  tabParent?: SessionState
  session?: SessionState
  surface?: NativeBrowserSurface
  creating: boolean
  abandoned: boolean
  cleanup?: Promise<void>
}

interface SessionState {
  id: string
  runId: string
  partition: string
  allowedFileRoots: string[]
  tabs: Map<string, TabState>
  pendingTabs: Set<OpeningReservation>
  activeTabId: string
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
  inputType?: string
  placeholder?: string
  selectedValues?: string[]
  checked?: boolean
}

interface BrowserSelectMutationResult {
  changed: boolean
  expectedValues: string[]
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 800, deviceScaleFactor: 1 }
const DEFAULT_MAX_SESSIONS_PER_RUN = 2
const DEFAULT_MAX_TOTAL_SESSIONS = 3
const DEFAULT_MAX_TABS = 4
const DEFAULT_MAX_ARTIFACTS = 200
const DEFAULT_MAX_ARTIFACT_BYTES = 250 * 1024 * 1024
const DEFAULT_MAX_ARTIFACTS_PER_SESSION = 50
const DEFAULT_MAX_ARTIFACT_BYTES_PER_SESSION = 64 * 1024 * 1024
const DEFAULT_MAX_REMOTE_PDF_BYTES = 64 * 1024 * 1024
const DEFAULT_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_TELEMETRY = 2_000
const DEFAULT_MAX_REPEATED_NO_CHANGE = 3
const MAX_SEMANTIC_NODES = 800
const MAX_SEMANTIC_CHARS = 96 * 1024
const MAX_EVALUATION_BYTES = 64 * 1024
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

/**
 * Browser targets are CSS viewport pixels, while sendInputEvent() takes view
 * pixels. They differ by the page zoom, which follows the app's zoom (0.9 by
 * default) while the browser is shown inside the app; unscaled, every click
 * landed past its target.
 */
export function toViewInputEvent<
  T extends MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent
>(event: T, zoomFactor: number): T {
  if (!('x' in event) || !Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor === 1)
    return event
  return { ...event, x: event.x * zoomFactor, y: event.y * zoomFactor }
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

/**
 * Chromium's own words for a call that outlived the document or node it targeted, as when the
 * page navigates in the middle of an action.
 */
const LOST_PAGE_PROTOCOL_ERROR =
  /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Cannot find object with id|No node with given id|Could not find node with given id|Node with given id does not belong to the document|Node is detached from document/i

/** The agent gets SideKick's explanation, not a protocol error, when the page moved on. */
export function pageChangedError(error: unknown): unknown {
  return error instanceof Error && LOST_PAGE_PROTOCOL_ERROR.test(error.message)
    ? new Error('Browser page changed during this action; observe it before trying again')
    : error
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    // Callers may have already dispatched CDP before cancellation became visible.
    // Observe its eventual rejection even when we cannot await its result.
    void promise.catch(() => undefined)
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

/**
 * A page held by a JavaScript dialog or a busy script never answers; a bounded wait turns that
 * into an error the agent can act on instead of a run that never ends.
 */
async function pageAnswer<T>(operation: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The page did not respond within ${limitMs / 1000} s; it may be showing a dialog or running a long script`
          )
        ),
      limitMs
    )
  })
  try {
    return await Promise.race([operation, stuck])
  } finally {
    clearTimeout(timer)
  }
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

const SECRET_SHOWN_MESSAGE =
  'No screenshot: a stored password on this page is shown as plain text. Hide it again, submit the form, or leave the page first.'

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

function isRemotePdfUrl(url: string): boolean {
  const parsed = new URL(url)
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    extname(parsed.pathname).toLowerCase() === '.pdf'
  )
}

function remotePdfName(url: string, contentDisposition: string | null): string {
  const encodedName = contentDisposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
  const quotedName = contentDisposition?.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
  const plainName = contentDisposition?.match(/filename\s*=\s*([^;]+)/i)?.[1]
  let candidate = encodedName ?? quotedName ?? plainName
  if (encodedName) {
    try {
      candidate = decodeURIComponent(encodedName)
    } catch {
      candidate = encodedName
    }
  }
  if (!candidate) {
    try {
      candidate = decodeURIComponent(basename(new URL(url).pathname))
    } catch {
      candidate = basename(new URL(url).pathname)
    }
  }
  const safe = basename(String(candidate || 'document.pdf').trim())
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\p{Cc}/gu, '_')
    .slice(0, 180)
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe || 'document'}.pdf`
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Remote PDF exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      const chunk = Buffer.from(item.value)
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Remote PDF exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`)
      }
      chunks.push(chunk)
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks, total)
}

function isTransientViewportCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return ['UnknownVizError', 'Current display surface not available for capture'].includes(
    message.trim()
  )
}

/**
 * An SVG file opened on its own is drawn at the size written in it, in the top-left corner of a
 * white page, so it overflowed a narrow panel or sat small in a wide one. Like an image viewer,
 * one with a viewBox is fitted to the window and centred on a neutral checkerboard instead; the
 * selector matches only when the document itself is an SVG, never an SVG inside a web page.
 */
export const STANDALONE_SVG_VIEWER_CSS = `svg:root[viewBox] {
  width: 100vw !important;
  height: 100vh !important;
  background-color: #f4f4f4;
  background-image: conic-gradient(#e6e6e6 25%, transparent 0 50%, #e6e6e6 0 75%, transparent 0);
  background-size: 16px 16px;
}`

export class ElectronNativeBrowserSurface implements NativeBrowserSurface {
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
  private certificateGuard: (event: BrowserCertificateEvent) => boolean = () => false
  private debuggerOwned = false
  /** A viewport the agent set, and the scale it is drawn at where it is shown. */
  private agentViewport?: BrowserViewport
  private agentViewportScale = 1

  constructor(
    private readonly contents: WebContents,
    private readonly ownerWindow: ElectronBrowserWindow | null,
    readonly attached: boolean,
    private readonly view?: import('electron').WebContentsView
  ) {
    this.webContentsId = contents.id
    contents.on('dom-ready', () => {
      void contents.insertCSS(STANDALONE_SVG_VIEWER_CSS).catch(() => undefined)
    })
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
    // This tab's own event, not the app-wide one: no other traffic can reach this decision, and a
    // contents the service attached to keeps Chromium's refusal.
    if (!attached) {
      contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
        event.preventDefault()
        callback(
          this.certificateGuard({
            url,
            error,
            fingerprint: certificate.fingerprint,
            subject: certificate.subjectName,
            issuer: certificate.issuerName,
            validUntil: certificate.validExpiry,
            isMainFrame,
            pageUrl: contents.getURL()
          })
        )
      })
    }
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

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (init?.redirect !== 'manual') return this.contents.session.fetch(url, init)
    // Electron fetch rejects manual redirects instead of returning their headers.
    // Expose one hop; the service validates each destination before another request.
    const { net } = await import('electron')
    return new Promise<Response>((resolve, reject) => {
      const request = net.request({
        url,
        method: init.method || 'GET',
        session: this.contents.session,
        credentials: init.credentials || 'include',
        redirect: 'manual',
        headers: Object.fromEntries(new Headers(init.headers).entries())
      })
      const abort = (): void => {
        reject(init.signal?.reason || new Error('Download cancelled'))
        request.abort()
      }
      request.on('error', reject)
      request.once('close', () => init.signal?.removeEventListener('abort', abort))
      request.once('redirect', (status, _method, destination) => {
        resolve(new Response(null, { status, headers: { location: destination } }))
        request.abort()
      })
      request.once('response', (incoming) => {
        const headers = new Headers()
        for (const [name, values] of Object.entries(incoming.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value)
        }
        let ended = false
        const body = [204, 205, 304].includes(incoming.statusCode)
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                const fail = (error: Error): void => {
                  if (ended) return
                  ended = true
                  controller.error(error)
                }
                incoming.on('data', (chunk) => {
                  if (!ended) controller.enqueue(chunk)
                })
                incoming.once('end', () => {
                  if (ended) return
                  ended = true
                  controller.close()
                })
                incoming.once('error', fail)
                incoming.once('aborted', () => fail(new Error('Download interrupted')))
              },
              cancel() {
                ended = true
                request.abort()
              }
            })
        resolve(new Response(body, { status: incoming.statusCode, headers }))
      })
      init.signal?.addEventListener('abort', abort, { once: true })
      if (init.signal?.aborted) abort()
      else request.end()
    })
  }

  stop(): void {
    if (!this.contents.isDestroyed()) this.contents.stop()
  }

  async close(): Promise<void> {
    if (this.contents.isDestroyed()) return
    parkBrowserView(this.webContentsId)
    this.detachDebugger()
    this.clearListeners()
    if (!this.attached) {
      if (this.view) this.contents.close({ waitForBeforeUnload: false })
      if (this.ownerWindow && !this.ownerWindow.isDestroyed()) this.ownerWindow.destroy()
      else this.contents.close({ waitForBeforeUnload: false })
    }
  }

  focus(): void {
    if (!this.contents.isDestroyed()) this.contents.focus()
  }

  async insertText(text: string): Promise<void> {
    // Keys from sendInputEvent() wait in the page's input queue, while contents.insertText()
    // arrives by frame IPC and can overtake them: a Backspace sent to clear the field then
    // deletes the end of the new text. Chromium queues this commit behind the keys sent before
    // it, and answers only once the page has applied it.
    await this.sendDebuggerCommand('Input.insertText', { text })
  }

  sendInputEvent(event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void {
    void browserAgentInput(this.webContentsId, () =>
      this.contents.sendInputEvent(
        toViewInputEvent(event, this.contents.getZoomFactor() * this.agentViewportScale)
      )
    )
  }

  showPointer(x: number, y: number): void {
    void showBrowserPointer(this.webContentsId, x, y).catch(() => undefined)
  }

  async setAgentViewport(
    viewport: BrowserViewport,
    options: BrowserEmulationOptions = {}
  ): Promise<void> {
    this.agentViewport = viewport
    const mobile = options.mobile === true
    const apply = async ({ scale, height }: BrowserViewportFit): Promise<void> => {
      this.agentViewportScale = scale
      // The laid-out height can grow to fill the panel; screenshots capture what is laid out.
      this.agentViewport = { ...viewport, height }
      await this.sendDebuggerCommand('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile,
        screenWidth: viewport.width,
        screenHeight: height,
        scale
      })
    }
    await this.sendDebuggerCommand('Emulation.setTouchEmulationEnabled', {
      enabled: mobile,
      ...(mobile ? { maxTouchPoints: 5 } : {})
    })
    await this.sendDebuggerCommand('Emulation.setUserAgentOverride', {
      userAgent: options.userAgent ?? this.contents.getUserAgent()
    })
    const placed = await setBrowserViewAgentViewport(
      this.webContentsId,
      { width: viewport.width, height: viewport.height, fillHeight: !mobile },
      apply
    )
    if (!placed) await apply({ scale: 1, height: viewport.height })
  }

  async clearAgentViewport(): Promise<void> {
    if (!this.agentViewport) return
    this.agentViewport = undefined
    this.agentViewportScale = 1
    await setBrowserViewAgentViewport(this.webContentsId, null, async () => undefined)
    await this.sendDebuggerCommand('Emulation.clearDeviceMetricsOverride')
    await this.sendDebuggerCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    await this.sendDebuggerCommand('Emulation.setUserAgentOverride', {
      userAgent: this.contents.getUserAgent()
    })
  }

  resizeViewport(viewport: BrowserViewport): void {
    if (this.view && !browserViewHost(this.webContentsId))
      this.view.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height })
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.setContentSize(viewport.width, viewport.height, false)
    }
  }

  async executeJavaScript<T>(source: string): Promise<T> {
    return (await pageAnswer(this.contents.executeJavaScript(source, true), 30_000)) as T
  }

  async captureViewport(): Promise<NativeBrowserSurfaceCapture> {
    // An agent viewport's laid-out height and emulated scale both depend on where the page now is.
    await browserViewLayoutSettled(this.webContentsId)
    this.contents.invalidate()
    if (
      this.view &&
      !browserViewHost(this.webContentsId) &&
      this.ownerWindow &&
      !this.ownerWindow.isDestroyed()
    ) {
      // Warming the parking window is best-effort: its compositor surface may
      // disappear during tab swaps even when the actual page can be captured.
      await this.ownerWindow
        .capturePage(undefined, { stayHidden: true, stayAwake: true })
        .catch((error) => {
          if (!isTransientViewportCaptureError(error)) throw error
        })
    }
    // Ask Chromium for the agent's viewport itself, at full size, whether the panel shows it
    // scaled down or it is parked. Chromium draws a fresh frame for this capture. capturePage()
    // copies whatever frame the view last showed: just after mounting or parking, that can still
    // be drawn at the old scale, even once the new metrics have been accepted.
    const agentViewport = this.agentViewport
    let image = await (
      agentViewport
        ? this.sendDebuggerCommand<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: 0,
              y: 0,
              width: agentViewport.width,
              height: agentViewport.height,
              scale: 1
            }
          }).then(async (response) =>
            (await import('electron')).nativeImage.createFromBuffer(
              Buffer.from(response.data, 'base64')
            )
          )
        : !this.view && this.ownerWindow && !this.ownerWindow.isDestroyed()
          ? this.ownerWindow.capturePage(undefined, { stayHidden: true, stayAwake: true })
          : this.contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    ).catch(async (error) => {
      if (!isTransientViewportCaptureError(error)) throw error
      // The native window surface can be unavailable for parked popups. Ask
      // Chromium for the current viewport directly; never reuse an old image.
      const response = await this.sendDebuggerCommand<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      })
      const { nativeImage } = await import('electron')
      return nativeImage.createFromBuffer(Buffer.from(response.data, 'base64'))
    })
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
    // Full-page and element screenshots measure and capture the layout the page is moving to.
    if (method === 'Page.captureScreenshot' || method === 'Page.getLayoutMetrics')
      await browserViewLayoutSettled(this.webContentsId)
    if (
      !this.view &&
      method === 'Page.captureScreenshot' &&
      this.ownerWindow &&
      !this.ownerWindow.isDestroyed() &&
      !this.ownerWindow.isVisible()
    ) {
      this.ownerWindow.setSkipTaskbar(true)
      this.ownerWindow.setPosition(-32_000, -32_000, false)
      this.ownerWindow.showInactive()
    }
    return pageAnswer(
      browserDebuggerCommand(this.webContentsId, method, () =>
        this.contents.debugger.sendCommand(method, params)
      ),
      method === 'Page.captureScreenshot' ? 60_000 : 30_000
    ) as Promise<T>
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

  setCertificateGuard(guard: (event: BrowserCertificateEvent) => boolean): void {
    this.certificateGuard = guard
  }

  async closeConnections(): Promise<void> {
    if (!this.attached && !this.contents.isDestroyed())
      await this.contents.session.closeAllConnections()
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
      opacity: process.platform === 'darwin' ? 0.01 : 1,
      focusable: false,
      width: options.viewport.width,
      height: options.viewport.height,
      useContentSize: true,
      title: 'SideKick Browser',
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#090b0e',
      paintWhenInitiallyHidden: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const view = new electron.WebContentsView({
      webPreferences: {
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        // Chromium's own WebMCP, off by default in Electron 43: pages can offer tools that the
        // agent lists and calls through the DevTools WebMCP domain. Only these tabs get it.
        enableBlinkFeatures: 'WebMCP',
        // Use a normal WebContents so the Browser panel can show this exact
        // tab. Full-page CDP capture briefly wakes the window offscreen to
        // keep Chromium's compositor responsive.
        offscreen: false,
        devTools: false
      }
    })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: options.viewport.width, height: options.viewport.height })
    registerBrowserView(view, window)
    view.webContents.setBackgroundThrottling(false)
    const browserSession = view.webContents.session
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
    // putting the browser in the taskbar or on a usable display.
    window.showInactive()
    return new ElectronNativeBrowserSurface(view.webContents, window, false, view)
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
  workspaceSnapshot(sessionId: string) {
    const session = this.getSession(sessionId)
    const tab = this.getTab(session)
    const tools = tab.webMcp.snapshot()
    return {
      sessionId,
      activeTabId: session.activeTabId,
      tabs: this.tabSummaries(session),
      device: tab.device ?? null,
      certificate: this.shownCertificateNotice(tab) ?? null,
      pageTools: tools.tools.length
        ? {
            origin: tools.origin,
            tools: tools.tools.map((tool) => ({
              name: tool.name,
              description: tool.description.slice(0, 300),
              readOnly: tool.readOnly,
              form: tool.form
            }))
          }
        : null,
      ...browserNavigationState(tab.surface.webContentsId)
    }
  }

  /**
   * Asks the user about the certificate refused on the active tab, and returns the address to open
   * if they allow it. It takes nothing from the caller, and only the Browser panel's request leads
   * here: what the dialog shows and the approval records is what Chromium reported to this process.
   * It waits outside the session's queue, because the user may take their time.
   */
  async approveCertificate(sessionId: string): Promise<string | undefined> {
    const tab = this.getTab(this.getSession(sessionId))
    const failure = tab.certificate
    const policy = this.options.certificatePolicy
    if (!failure || !policy || !this.shownCertificateNotice(tab)?.canContinue) return undefined
    return (await policy.approve(failure)) ? failure.url : undefined
  }

  /** What to say about the tab's refused page, while the tab is still on it. */
  private shownCertificateNotice(tab: TabState): BrowserCertificateNotice | undefined {
    const failure = tab.certificate
    if (!failure) return undefined
    const notice = certificateNotice(failure, this.options.certificatePolicy)
    try {
      return new URL(tab.surface.getURL()).origin === notice.origin ? notice : undefined
    } catch {
      return undefined
    }
  }

  /** After an approval is removed, so no connection already past the certificate outlives it. */
  async closeConnections(): Promise<void> {
    const surfaces = [...this.sessions.values()].flatMap((session) =>
      [...session.tabs.values()].map((tab) => tab.surface)
    )
    await Promise.all(surfaces.map((surface) => surface.closeConnections?.()))
  }

  /**
   * The active tab, for the marks the user makes on it in the Browser panel. They are read over
   * the protocol only, never by running script in the page, and outside the session's action
   * queue: reading does not change the page, and the user may mark it while the agent works.
   */
  annotationPage(sessionId: string): import('./browserAnnotations').BrowserAnnotationPage {
    const session = this.getSession(sessionId)
    const tab = this.getTab(session)
    return {
      tabId: tab.id,
      webContentsId: tab.surface.webContentsId,
      url: this.tabUrl(tab),
      title: tab.surface.getTitle(),
      send: (method, params) => tab.surface.sendDebuggerCommand(method, params),
      secretShownAsText: () => this.secretShownAsText(tab)
    }
  }

  refreshAfterUserInput(sessionId: string): void {
    const session = this.getSession(sessionId)
    for (const tab of session.tabs.values()) this.invalidateSemanticRefs(tab)
  }
  private readonly sessions = new Map<string, SessionState>()
  private readonly retiredSessions = new Set<SessionState>()
  private readonly openingReservations = new Set<OpeningReservation>()
  private readonly runtime: NativeBrowserRuntime
  private readonly artifactRoot: string
  private readonly defaultAllowedFileRoots: string[]
  private readonly maxSessionsPerRun: number
  private readonly maxTotalSessions: number
  private readonly maxTabsPerSession: number
  private readonly maxArtifacts: number
  private readonly maxArtifactBytes: number
  private readonly maxRemotePdfBytes: number
  private readonly pdfOutputRoot: string
  private readonly artifactRetentionMs: number
  private readonly maxTelemetryEntries: number
  private readonly maxRepeatedNoChangeActions: number
  private readonly defaultViewport: BrowserViewport
  private readonly now: () => number
  private artifactTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NativeBrowserSessionServiceOptions) {
    if (!options.artifactRoot) throw new Error('A browser artifact root is required')
    this.artifactRoot = resolve(options.artifactRoot)
    this.pdfOutputRoot = resolve(options.pdfOutputRoot ?? options.artifactRoot)
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
    this.maxRemotePdfBytes = boundedInteger(
      options.maxRemotePdfBytes ?? DEFAULT_MAX_REMOTE_PDF_BYTES,
      1024 * 1024,
      512 * 1024 * 1024,
      'maxRemotePdfBytes'
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
    const ownedSessions = new Set([...this.sessions.values(), ...this.retiredSessions])
    const pending = [...this.openingReservations].filter(
      (reservation) => !reservation.session || !ownedSessions.has(reservation.session)
    )
    if (ownedSessions.size + pending.length >= this.maxTotalSessions) {
      throw new Error(`The browser session limit (${this.maxTotalSessions}) is reached`)
    }
    const runCount = [...ownedSessions, ...pending].filter(
      (session) => session.runId === input.runId
    ).length
    if (runCount >= this.maxSessionsPerRun) {
      throw new Error(
        `Run ${input.runId} already has the maximum ${this.maxSessionsPerRun} browser sessions`
      )
    }

    const reservation: OpeningReservation = {
      runId: input.runId,
      creating: false,
      abandoned: false
    }
    this.openingReservations.add(reservation)
    try {
      signal?.throwIfAborted()
      return await this.openReserved(input, signal, reservation)
    } finally {
      reservation.abandoned = true
      if (this.openingReservations.has(reservation) && !reservation.creating) {
        await abortable(this.cleanupOpening(reservation), AbortSignal.timeout(2_000)).catch(
          () => undefined
        )
      }
    }
  }

  private async createOpeningSurface(
    reservation: OpeningReservation,
    create: () => Promise<NativeBrowserSurface>,
    signal?: AbortSignal
  ): Promise<NativeBrowserSurface> {
    signal?.throwIfAborted()
    reservation.creating = true
    const creation = Promise.resolve()
      .then(() => {
        signal?.throwIfAborted()
        return create()
      })
      .then(
        (surface) => {
          reservation.creating = false
          reservation.surface = surface
          if (reservation.abandoned) void this.cleanupOpening(reservation).catch(() => undefined)
          return surface
        },
        (error) => {
          reservation.creating = false
          if (reservation.abandoned) this.releaseReservation(reservation)
          throw error
        }
      )
    return abortable(creation, signal)
  }

  private cleanupOpening(reservation: OpeningReservation): Promise<void> {
    if (reservation.cleanup) return reservation.cleanup
    const cleanup = Promise.resolve().then(async () => {
      if (reservation.creating) throw new Error('Browser surface creation is still pending')
      if (reservation.surface) await reservation.surface.close()
      reservation.surface = undefined
      this.releaseReservation(reservation)
    })
    reservation.cleanup = cleanup
    void cleanup.then(
      () => {
        reservation.cleanup = undefined
      },
      () => {
        reservation.cleanup = undefined
      }
    )
    return cleanup
  }

  private releaseReservation(reservation: OpeningReservation): void {
    this.openingReservations.delete(reservation)
    if (reservation.tabParent) {
      reservation.tabParent.pendingTabs.delete(reservation)
      if (this.sessions.get(reservation.tabParent.id) !== reservation.tabParent) {
        this.retireSession(reservation.tabParent)
      }
    }
  }

  private async openReserved(
    input: BrowserOpenInput,
    signal: AbortSignal | undefined,
    reservation: OpeningReservation
  ): Promise<BrowserObservation> {
    const viewport = this.normalizeViewport(input.viewport ?? this.defaultViewport)
    const allowedFileRoots = await this.resolveFileRoots(input.allowedFileRoots ?? [])
    const initialUrl = input.url
      ? await this.normalizeNavigationUrl(input.url, allowedFileRoots, signal)
      : undefined
    const id = randomUUID()
    const partition = `sidekick-browser-${safeSegment(input.runId)}-${id}`
    let surface: NativeBrowserSurface | undefined
    let openingSession: SessionState | undefined
    try {
      if (input.attachWebContentsId !== undefined) {
        const allowlisted = this.options.allowedAttachWebContentsIds?.has(input.attachWebContentsId)
        if (!allowlisted && !this.options.canAttachWebContents) {
          throw new Error('Attaching arbitrary WebContents is disabled')
        }
        const webContentsId = input.attachWebContentsId
        surface = await this.createOpeningSurface(
          reservation,
          () => this.runtime.attachSurface(webContentsId),
          signal
        )
        if (
          !allowlisted &&
          !this.options.canAttachWebContents?.(input.attachWebContentsId, surface.getURL())
        ) {
          throw new Error('This WebContents is not approved for browser attachment')
        }
        const attachedUrl = surface.getURL() || 'about:blank'
        if (new URL(attachedUrl).protocol === 'file:') {
          throw new Error('Attaching an existing file:// WebContents is not supported')
        }
        await this.normalizeNavigationUrl(attachedUrl, allowedFileRoots)
      } else {
        surface = await this.createOpeningSurface(
          reservation,
          () => this.runtime.createSurface({ partition, viewport }),
          signal
        )
        // A committed document is required before Accessibility/DOM domains are enabled.
        await this.commitBlankDocument(surface, signal)
      }

      const session: SessionState = {
        id,
        runId: input.runId,
        partition,
        allowedFileRoots,
        tabs: new Map(),
        pendingTabs: new Set(),
        activeTabId: '',
        console: [],
        failures: [],
        consoleSequence: 0,
        networkSequence: 0,
        tail: Promise.resolve(),
        createdAt: this.now()
      }
      openingSession = session
      reservation.session = session
      this.sessions.set(id, session)
      const tab = await this.registerSurface(session, surface, signal)
      reservation.surface = undefined
      this.openingReservations.delete(reservation)
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
      if (openingSession) {
        this.retireSession(openingSession)
        if (openingSession.tabs.size) {
          await abortable(this.closeSessionTabs(openingSession), AbortSignal.timeout(2_000)).catch(
            () => undefined
          )
        }
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

  /** This computer, or a local-network origin the user approved. */
  private plainHttpAllowed(url: URL): boolean {
    if (loopbackHost(url.hostname)) return true
    return Boolean(
      privateNetworkHost(url.hostname) &&
      this.options.networkPolicy?.approved(browserNetworkOrigin(url))
    )
  }

  private navigationUrlAllowedSync(input: string, allowedFileRoots: string[]): boolean {
    try {
      const url = new URL(input)
      if (url.username || url.password) return false
      if (url.protocol === 'about:') return url.href === 'about:blank'
      if (url.protocol === 'https:') return true
      if (url.protocol === 'http:') return this.plainHttpAllowed(url)
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return false
      // The native implementation expands Windows 8.3 aliases (for example
      // RUNNER~1), keeping request checks aligned with async fs.realpath roots.
      const candidate = realpathSync.native(resolve(fileURLToPath(url)))
      return allowedFileRoots.some((root) => isPathWithin(root, candidate))
    } catch {
      return false
    }
  }

  private async normalizeNavigationUrl(
    input: string,
    allowedFileRoots: string[],
    signal?: AbortSignal
  ): Promise<string> {
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
      if (this.plainHttpAllowed(url)) return url.href
      const policy = this.options.networkPolicy
      if (policy && privateNetworkHost(url.hostname)) {
        if (await policy.approve(browserNetworkOrigin(url), signal)) return url.href
        throw new Error(
          `The user did not allow the browser to open ${browserNetworkOrigin(url)}. Ask them before trying it again.`
        )
      }
      throw new Error(
        'Plain HTTP is allowed only for this computer and approved local-network addresses; use HTTPS'
      )
    }
    if (url.protocol !== 'file:') {
      throw new Error(
        'Only HTTPS, plain HTTP on this computer or an allowed local-network address, and approved local file URLs are supported'
      )
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
    this.assertCurrentSession(session)
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
    this.assertCurrentSession(session)
    const tab: TabState = {
      id: randomUUID(),
      surface,
      pdfSessionTokens: new Set(),
      temporaryPdfSources: new Set(),
      refEpoch: 1,
      refs: new Map(),
      semanticNodes: [],
      consoleCursor: session.consoleSequence,
      networkCursor: session.networkSequence,
      lastScreenshotHashes: {},
      unchangedScreenshotStreaks: {},
      inFlight: new Map(),
      actionHistory: [],
      disposers: [],
      webMcp: new WebMcpPageTools()
    }
    session.tabs.set(tab.id, tab)
    if (!surface.attached) {
      surface.setCertificateGuard((event) => this.judgeCertificate(session, tab, event))
    }
    tab.disposers.push(
      surface.onConsole((message) => this.recordConsole(session, tab, message)),
      surface.onLoadFailure((failure) => this.recordLoadFailure(session, tab, failure)),
      surface.onDebuggerMessage((method, params) =>
        this.handleDebuggerMessage(session, tab, method, params)
      ),
      surface.onDestroyed(() => this.handleSurfaceDestroyed(session, tab)),
      surface.onOpenUrl((url) => {
        void this.openPopup(session, url).catch((error) => {
          this.recordConsole(session, tab, {
            level: 'error',
            message: `Blocked popup: ${error instanceof Error ? error.message : String(error)}`
          })
        })
      })
    )
    if (!surface.attached) await this.enableWebMcp(tab, signal)
    return tab
  }

  /**
   * Starts reading the tab's WebMCP tools from Chromium. A tab where this fails, as with a Chromium
   * without the domain, simply offers no tools.
   */
  private async enableWebMcp(tab: TabState, signal?: AbortSignal): Promise<void> {
    const command = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      abortable(
        tab.surface.sendDebuggerCommand<T>(method, params),
        signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000)
      )
    try {
      await command('Page.addScriptToEvaluateOnNewDocument', {
        source: WEBMCP_COMPATIBILITY_SCRIPT
      })
      const tree = await command<{ frameTree?: { frame?: Record<string, unknown> } }>(
        'Page.getFrameTree'
      )
      if (!tree?.frameTree?.frame) return
      // Enabling replays the tools the document already has, so the frame must be known first.
      tab.webMcp.attach(tree.frameTree.frame)
      await command('WebMCP.enable')
      tab.webMcp.available = true
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }

  /** Chromium would refuse this connection; only an approval already made lets it go on. */
  private judgeCertificate(
    session: SessionState,
    tab: TabState,
    event: BrowserCertificateEvent
  ): boolean {
    const policy = this.options.certificatePolicy
    const allowed = Boolean(policy && certificateAllowed(event, policy))
    if (event.isMainFrame) {
      const { isMainFrame: _isMainFrame, pageUrl: _pageUrl, ...failure } = event
      tab.certificate = allowed ? undefined : failure
    } else if (!allowed) {
      this.recordConsole(session, tab, {
        level: 'error',
        message: `Blocked ${event.url}: its certificate is not trusted (${event.error})`
      })
    }
    return allowed
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
    if (
      method.startsWith('WebMCP.') ||
      method === 'Page.frameNavigated' ||
      method === 'Page.navigatedWithinDocument'
    ) {
      tab.webMcp.handle(method, params)
    }
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
    tab.webMcp.close()
    for (const token of tab.pdfSessionTokens) revokeBrowserPdfSession(token)
    tab.pdfSessionTokens.clear()
    void this.cleanupTemporaryPdfSources(tab)
    for (const dispose of tab.disposers.splice(0)) dispose()
    session.tabs.delete(tab.id)
    if (session.activeTabId === tab.id) session.activeTabId = session.tabs.keys().next().value ?? ''
    if (!session.tabs.size) {
      this.retireSession(session)
    }
  }

  private async createOwnedTab(
    session: SessionState,
    viewport: BrowserViewport,
    signal?: AbortSignal
  ): Promise<TabState> {
    this.assertCurrentSession(session)
    if (session.tabs.size + session.pendingTabs.size >= this.maxTabsPerSession) {
      throw new Error(`The browser tab limit (${this.maxTabsPerSession}) is reached`)
    }
    const reservation: OpeningReservation = {
      runId: session.runId,
      tabParent: session,
      creating: false,
      abandoned: false
    }
    session.pendingTabs.add(reservation)
    try {
      const surface = await this.createOpeningSurface(
        reservation,
        () => this.runtime.createSurface({ partition: session.partition, viewport }),
        signal
      )
      this.assertCurrentSession(session)
      // CDP Accessibility/DOM domains can stall until Chromium commits its first document.
      await this.commitBlankDocument(surface, signal)
      const tab = await this.registerSurface(session, surface, signal)
      reservation.surface = undefined
      this.releaseReservation(reservation)
      return tab
    } finally {
      reservation.abandoned = true
      if (session.pendingTabs.has(reservation) && !reservation.creating) {
        await abortable(this.cleanupOpening(reservation), AbortSignal.timeout(2_000)).catch(
          () => undefined
        )
      }
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

  private async openPopup(session: SessionState, inputUrl: string): Promise<void> {
    const url = await this.normalizeNavigationUrl(inputUrl, session.allowedFileRoots)
    await this.withSessionLock(session, {}, async (signal) => {
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
      this.assertCurrentSession(session)
      return await body(signal)
    } finally {
      release()
    }
  }

  private assertCurrentSession(session: SessionState): void {
    if (this.sessions.get(session.id) !== session) {
      throw new Error('Browser session not found or already closed')
    }
  }

  private retireSession(session: SessionState): void {
    if (this.sessions.get(session.id) === session) {
      revokeBrowserPdfSessionsByOwner(session.id)
      this.sessions.delete(session.id)
      if (session.tabs.size || session.pendingTabs.size) this.retiredSessions.add(session)
    }
    if (!session.tabs.size && !session.pendingTabs.size) this.retiredSessions.delete(session)
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
        url = await this.normalizeNavigationUrl(input.url, session.allowedFileRoots, signal)
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
      tab.certificate = undefined
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
        const entryUrl = pdfSession
          ? (pdfSession.logicalUrl ?? pathToFileURL(pdfSession.sourcePath).href)
          : entry.url
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
    let newPdfSourcePath: string | undefined
    if (new URL(url).protocol === 'file:' && extname(fileURLToPath(url)).toLowerCase() === '.pdf') {
      const pdfSession = createBrowserPdfSession(fileURLToPath(url), session.id, {
        publicationRoot: session.allowedFileRoots.find((root) =>
          isPathWithin(root, fileURLToPath(url))
        ),
        logicalUrl: url
      })
      newPdfToken = pdfSession.token
      tab.pdfSessionTokens.add(pdfSession.token)
      navigationUrl = browserPdfViewerUrl(pdfSession)
    } else if (isRemotePdfUrl(url)) {
      const remotePdf = await this.downloadRemotePdf(session, tab, url, signal).catch((error) => {
        throw this.certificateRefusal(tab, url, error)
      })
      newPdfSourcePath = remotePdf.sourcePath
      const pdfSession = createBrowserPdfSession(remotePdf.sourcePath, session.id, {
        sourceName: remotePdf.sourceName,
        logicalUrl: url,
        outputDirectory: this.pdfOutputRoot
      })
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
      if (newPdfSourcePath) {
        tab.temporaryPdfSources.delete(newPdfSourcePath)
        await fs.unlink(newPdfSourcePath).catch(() => undefined)
      }
      throw this.certificateRefusal(tab, url, error)
    }
    tab.logicalUrl = newPdfToken ? url : undefined
    tab.pdfSessionToken = newPdfToken
    return this.waitForQuiescence(tab, this.navigationQuiescence(navigationUrl), signal)
  }

  /**
   * A load refused for its certificate, in words the user and the agent can act on. A download has
   * no page to report the certificate, so it fails with no way past it.
   */
  private certificateRefusal(tab: TabState, url: string, error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error)
    const code = /\bERR_CERT_[A-Z_]+/.exec(message)?.[0]
    if (!code) return error
    return new BrowserCertificateError(
      tab.certificate
        ? certificateNotice(tab.certificate, this.options.certificatePolicy)
        : {
            ...certificateNotice({
              url,
              error: code,
              fingerprint: '',
              subject: '',
              issuer: ''
            }),
            note: 'SideKick does not download files from an address whose certificate it cannot trust.',
            canContinue: false
          }
    )
  }

  private async downloadRemotePdf(
    session: SessionState,
    tab: TabState,
    sourceUrl: string,
    signal?: AbortSignal
  ): Promise<{ sourcePath: string; sourceName: string }> {
    let currentUrl = sourceUrl
    let response: Response | undefined
    for (let redirect = 0; redirect <= 5; redirect++) {
      response = await abortable(
        tab.surface.fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'include',
          headers: {
            accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1'
          },
          signal
        }),
        signal
      )
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new Error('Remote PDF redirect did not include a destination')
      if (redirect === 5) throw new Error('Remote PDF exceeded the redirect limit')
      currentUrl = await this.normalizeNavigationUrl(
        new URL(location, currentUrl).href,
        session.allowedFileRoots
      )
      const redirected = new URL(currentUrl)
      if (
        redirected.protocol !== 'https:' &&
        !(redirected.protocol === 'http:' && this.plainHttpAllowed(redirected))
      ) {
        throw new Error('Remote PDF redirects must remain on an approved network URL')
      }
    }
    if (!response?.ok) {
      throw new Error(`Remote PDF download failed with HTTP ${response?.status ?? 'unknown'}`)
    }
    const bytes = await readBoundedResponse(response, this.maxRemotePdfBytes, signal)
    if (bytes.byteLength < 5 || bytes.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0) {
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'unknown'
      throw new Error(`Remote URL did not return a valid PDF (content type: ${contentType})`)
    }
    const directory = join(
      this.artifactRoot,
      safeSegment(session.runId),
      safeSegment(session.id),
      safeSegment(tab.id)
    )
    await fs.mkdir(directory, { recursive: true })
    const [realRoot, realDirectory] = await Promise.all([
      fs.realpath(this.artifactRoot),
      fs.realpath(directory)
    ])
    if (!isPathWithin(realRoot, realDirectory) || realDirectory === realRoot) {
      throw new Error('Remote PDF cache escaped the browser artifact root')
    }
    const sourcePath = join(directory, `remote-${randomUUID()}.source.pdf`)
    const partialPath = `${sourcePath}.partial`
    try {
      await fs.writeFile(partialPath, bytes, { flag: 'wx', mode: 0o600, signal })
      await fs.rename(partialPath, sourcePath)
    } catch (error) {
      await Promise.all([
        fs.unlink(partialPath).catch(() => undefined),
        fs.unlink(sourcePath).catch(() => undefined)
      ])
      throw error
    }
    tab.temporaryPdfSources.add(sourcePath)
    return {
      sourcePath,
      sourceName: remotePdfName(currentUrl, response.headers.get('content-disposition'))
    }
  }

  async download(
    input: { sessionId: string; url: string; workspaceRoot: string; destination: string },
    operation: BrowserOperationOptions = {}
  ): Promise<{ path: string; bytes: number }> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      signal?.throwIfAborted()
      // The destination may be in any of the project's folders, which is then its boundary.
      const folder = locateWorkspacePath(input.workspaceRoot, input.destination)
      const publication = await capturePublicationDirectory(
        folder.root,
        dirname(resolve(folder.root, folder.path))
      )
      const destination = await resolveSecureWorkspacePath(input.workspaceRoot, input.destination, {
        rejectLinks: true
      })
      const tab = this.getTab(session)
      await this.assertAutomatedMutationAllowed(tab, signal)
      let url = input.url
      let response: Response | undefined
      for (let redirect = 0; redirect <= 5; redirect++) {
        url = await this.normalizeNavigationUrl(url, [])
        const parsed = new URL(url)
        if (
          parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && this.plainHttpAllowed(parsed))
        )
          throw new Error(
            'Downloads require HTTPS, or plain HTTP on this computer or an allowed local-network address'
          )
        response = await abortable(
          tab.surface.fetch(url, { redirect: 'manual', credentials: 'include', signal }),
          signal
        )
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location || redirect === 5)
          throw new Error('Download redirect limit or invalid destination')
        url = new URL(location, url).href
      }
      if (!response?.ok) throw new Error(`Download failed: HTTP ${response?.status ?? 'unknown'}`)
      const bytes = await readBoundedResponse(response, 25 * 1024 * 1024, signal)
      if (signal?.aborted) throw signal.reason
      await publication.prepare(signal)
      await atomicNewFile(
        destination,
        (handle) => handle.writeFile(bytes, { signal }),
        signal,
        () => publication.assertUnchanged()
      )
      return { path: destination, bytes: bytes.length }
    })
  }

  private async cleanupTemporaryPdfSources(tab: TabState): Promise<void> {
    const paths = [...tab.temporaryPdfSources]
    tab.temporaryPdfSources.clear()
    await Promise.all(paths.map((path) => fs.unlink(path).catch(() => undefined)))
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
    // The page's own changes from here on tell the next action's wait what is noise.
    await abortable(tab.surface.executeJavaScript(SETTLE_INSTALL_SCRIPT), signal).catch(
      () => undefined
    )
    const viewport = await abortable(this.currentViewport(tab), signal)
    let semanticSnapshot: string | undefined
    let semanticNodeCount: number | undefined
    if (options.includeSemanticSnapshot !== false) {
      const semantic = await this.captureSemanticSnapshot(tab, options.semanticDepth, signal)
      semanticSnapshot = semantic.snapshot
      semanticNodeCount = semantic.count
    }
    const screenshotKind = options.screenshot ?? 'viewport'
    let screenshot: BrowserScreenshotArtifact | undefined
    let screenshotError: string | undefined
    if (screenshotKind !== 'none' && (await this.secretShownAsText(tab, signal))) {
      screenshotError = SECRET_SHOWN_MESSAGE
    } else if (screenshotKind !== 'none') {
      try {
        screenshot = await this.captureAndStore(session, tab, screenshotKind, undefined, signal)
      } catch (error) {
        signal?.throwIfAborted()
        if (!isTransientViewportCaptureError(error) || tab.surface.isDestroyed()) throw error
        screenshotError =
          'Screenshot temporarily unavailable; no image was captured. The tab remains open. Observe again before making visual claims.'
      }
    }
    const consoleEntries = session.console.filter(
      (entry) => entry.tabId === tab.id && entry.sequence > tab.consoleCursor
    )
    const failures = session.failures.filter(
      (entry) => entry.tabId === tab.id && entry.sequence > tab.networkCursor
    )
    tab.consoleCursor = session.consoleSequence
    tab.networkCursor = session.networkSequence
    const humanVerification = await this.detectHumanVerification(tab, semanticSnapshot, signal)
    const webMcpTools = tab.webMcp.snapshot().tools.map((tool) => tool.name)
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
      ...(screenshotError ? { screenshotError } : {}),
      screenshotChanged: screenshot?.changed ?? null,
      unchangedScreenshotStreak:
        screenshot?.unchangedStreak ?? tab.unchangedScreenshotStreaks.viewport ?? 0,
      console: consoleEntries,
      failedRequests: failures,
      cursors: { console: session.consoleSequence, network: session.networkSequence },
      ...(webMcpTools.length ? { webMcpTools } : {})
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
      if (await this.secretShownAsText(tab, signal)) throw new Error(SECRET_SHOWN_MESSAGE)
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

    let elementBox: BrowserCaptureBox | undefined
    if (kind === 'element') {
      if (!target) throw new Error('An element screenshot requires a semantic target')
      const resolved = await this.resolveTarget(tab, target, false, signal)
      if (!resolved.backendNodeId) {
        throw new Error('Element screenshots require a semantic ref or role/name target')
      }
      elementBox = await this.elementBox(tab, resolved.backendNodeId, signal)
    }
    return captureBrowserScreenshot(
      {
        layoutMetrics: () =>
          abortable(
            tab.surface.sendDebuggerCommand<BrowserLayoutMetrics>('Page.getLayoutMetrics'),
            signal
          ),
        capture: (clip) =>
          abortable(
            tab.surface.sendDebuggerCommand<{ data: string }>('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
              captureBeyondViewport: true,
              clip
            }),
            signal
          )
      },
      elementBox
    )
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
    ).catch((error: unknown) => {
      throw pageChangedError(error)
    })
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
      ).catch((error: unknown) => {
        throw pageChangedError(error)
      })
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
    type Rect = {
      x: number
      y: number
      pageX: number
      pageY: number
      width: number
      height: number
    }
    const read = (): Promise<Rect> =>
      this.callOnNode<Rect>(
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
    // A page that scrolls smoothly is still moving the element for a few frames after it is
    // scrolled into view; its position counts once it holds still. The wait is kept here rather
    // than in the page, whose timers a hidden page slows to a crawl.
    let rect = await read()
    for (let attempt = 0; attempt < 15; attempt++) {
      await delay(30, signal)
      const next = await read()
      const settled = next && rect && next.x === rect.x && next.y === rect.y
      rect = next
      if (settled) break
    }
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
      // It is not an automated CAPTCHA solver; a detected anti-bot checkpoint
      // stops automated input until the user clears it in the Browser panel.
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
    // Every action that changes the page passes here first, so this is where it begins.
    const at = this.now()
    const mark = await abortable(
      tab.surface.executeJavaScript<{ token?: unknown; id?: unknown }>(SETTLE_MARK_SCRIPT),
      signal
    ).catch(() => undefined)
    tab.settleMark =
      typeof mark?.token === 'string' && typeof mark.id === 'string'
        ? { token: mark.token, id: mark.id, at }
        : undefined
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
      await enterBrowserText(
        {
          text: input.text,
          clear: input.clear !== false,
          submit: input.submit,
          insertEmpty: true,
          platform: process.platform
        },
        {
          ...this.textEntryDriver(tab, target, sourceUrl, sourceRefEpoch, signal, startedAt),
          verify:
            input.clear !== false
              ? async () => {
                  if (tab.surface.getURL() !== sourceUrl || tab.refEpoch !== sourceRefEpoch) {
                    throw new Error(
                      'Browser page changed after text entry; inspect the current page before retrying'
                    )
                  }
                  const actual = await this.inspectFormControl(tab, target.backendNodeId!, signal)
                  if (actual.kind !== 'textbox' || actual.value !== input.text) {
                    throw new Error(
                      'Browser text entry could not be verified; the field may have rejected or transformed the input. Inspect the page before retrying.'
                    )
                  }
                }
              : undefined
        }
      )
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

  async upload(
    input: { sessionId: string; target: BrowserTarget; workspaceRoot: string; paths: string[] },
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      if (!input.workspaceRoot || !input.paths.length || input.paths.length > 8)
        throw new Error('Upload requires a project and 1–8 project-relative files')
      const files: string[] = []
      let bytes = 0
      for (const path of input.paths) {
        const file = await resolveSecureWorkspacePath(input.workspaceRoot, path, {
          rejectLinks: true
        })
        const info = await fs.stat(file)
        if (!info.isFile()) throw new Error('Uploads must be regular files')
        bytes += info.size
        if (bytes > 25 * 1024 * 1024) throw new Error('Upload exceeds the 25 MiB combined limit')
        files.push(file)
      }
      const tab = this.getTab(session)
      const fingerprint = canonicalFingerprint({ action: 'upload', input })
      this.guardRepeatedAction(tab, fingerprint)
      await this.ensureBaselineHash(session, tab, signal)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const target = await this.resolveTarget(tab, input.target, false, signal)
      if (!target.backendNodeId)
        throw new Error('Upload requires a file-input reference or selector')
      const valid = await this.callOnNode<boolean>(
        tab,
        target.backendNodeId,
        `function() { return this.isConnected && this.tagName === 'INPUT' && this.type === 'file' && !this.disabled && (${files.length} === 1 || this.multiple); }`,
        [],
        signal
      )
      if (!valid)
        throw new Error('Target must be an enabled file input supporting the selected file count')
      const startedAt = this.now()
      await abortable(
        tab.surface.sendDebuggerCommand('DOM.setFileInputFiles', {
          backendNodeId: target.backendNodeId,
          files
        }),
        signal
      )
      const selected = await this.callOnNode<string[]>(
        tab,
        target.backendNodeId,
        'function() { return Array.from(this.files || []).map(file => file.name); }',
        [],
        signal
      )
      if (
        selected.length !== files.length ||
        selected.some((name, index) => name !== basename(files[index]))
      )
        throw new Error(
          'Upload selection could not be verified; inspect page state before retrying'
        )
      return this.finishAction(
        session,
        tab,
        'upload',
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
          return { kind: 'textbox', disabled, readOnly, value: String(this.value ?? ''), inputType,
            placeholder: String(this.getAttribute('placeholder') || this.getAttribute('aria-placeholder') || '') };
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

  /**
   * Sets a native date or time input, which ignores its value typed as text, the way the
   * browser's own picker does: through the value setter, then input and change events.
   */
  private async setNativeInputValue(
    tab: TabState,
    backendNodeId: number,
    value: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.callOnNode(
      tab,
      backendNodeId,
      `function(value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        this.focus();
        setter.call(this, value);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      [value],
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
    await enterBrowserText(
      { text: value, clear: true, platform: process.platform },
      this.textEntryDriver(tab, target, sourceUrl, sourceRefEpoch, signal)
    )
  }

  private textEntryDriver(
    tab: TabState,
    target: ElementPoint,
    sourceUrl: string,
    sourceRefEpoch: number,
    signal?: AbortSignal,
    startedAt?: number
  ): BrowserTextEntryDriver {
    let preInsertEmpty: boolean | null = null
    let initialFocusCheck = true
    return {
      click: () => this.clickFormControl(tab, target, signal),
      assertTarget: async () => {
        // Native mouse dispatch can acknowledge before Chromium applies focus.
        // Only settle the initial click: never retry after clearing/inserting,
        // refocus a different node, or tolerate navigation/cancellation.
        const attempts = initialFocusCheck ? 5 : 1
        initialFocusCheck = false
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            preInsertEmpty = await this.assertTextEntryTarget(
              tab,
              target.backendNodeId!,
              sourceUrl,
              sourceRefEpoch,
              signal
            )
            break
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes('Target text field did not retain focus') ||
              attempt === attempts - 1
            )
              throw error
            await delay(25, signal)
          }
        }
      },
      markPointer: () => this.setPointer(tab, target, 'type', startedAt),
      sendKey: (event) => {
        signal?.throwIfAborted()
        tab.surface.sendInputEvent(event)
      },
      insert: (text) => {
        // Check before constructing the promise: insertText dispatches immediately.
        signal?.throwIfAborted()
        return abortable(tab.surface.insertText(text), signal)
      },
      flush: async () => {
        await abortable(tab.surface.executeJavaScript('0'), signal)
      },
      failed: async (trace) => {
        type DiagnosticState = {
          connected: boolean
          targetFocused: boolean
          documentFocused: boolean
          empty: boolean
        }
        let state: DiagnosticState | null = null
        // Failure-only, read-only and bounded. No listeners or page state survive
        // this probe, and no values, target identifiers or page URLs are recorded.
        if (
          !signal?.aborted &&
          tab.surface.getURL() === sourceUrl &&
          tab.refEpoch === sourceRefEpoch
        ) {
          const timeout = AbortSignal.timeout(250)
          const diagnosticSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
          try {
            // Bound the entire probe, including callOnNode's releaseObject
            // finally block. Cleanup may finish later but must not hold the lock.
            const observed = await abortable(
              this.callOnNode<DiagnosticState>(
                tab,
                target.backendNodeId!,
                `function() {
              return {
                connected: this.isConnected === true,
                targetFocused: (${browserTextTargetOwnsFocus.toString()})(this),
                documentFocused: document.hasFocus(),
                empty: String(this.isContentEditable === true ? this.textContent ?? '' : this.value ?? '') === ''
              };
            }`,
                [],
                diagnosticSignal
              ),
              diagnosticSignal
            )
            if (
              observed &&
              ['connected', 'targetFocused', 'documentFocused', 'empty'].every(
                (key) => typeof observed[key as keyof DiagnosticState] === 'boolean'
              )
            )
              state = observed
          } catch {
            /* Keep unknown distinct from a negative observation. */
          }
        }
        console.warn('[NativeBrowser] Text entry failure diagnostics', {
          ...trace,
          sameUrl: tab.surface.getURL() === sourceUrl,
          sameEpoch: tab.refEpoch === sourceRefEpoch,
          cancelled: signal?.aborted === true,
          connected: state?.connected ?? null,
          targetFocused: state?.targetFocused ?? null,
          documentFocused: state?.documentFocused ?? null,
          preInsertEmpty,
          afterEmpty: state?.empty ?? null,
          // Nonempty-to-nonempty is deliberately unknown: do not retain content
          // or a content-derived hash just to diagnose a failed gesture.
          valueChanged:
            preInsertEmpty === null || !state
              ? null
              : preInsertEmpty !== state.empty
                ? true
                : state.empty
                  ? false
                  : null
        })
      }
    }
  }

  private async assertTextEntryTarget(
    tab: TabState,
    backendNodeId: number,
    sourceUrl: string,
    sourceRefEpoch: number,
    signal?: AbortSignal
  ): Promise<boolean | null> {
    const assertDocumentUnchanged = (): void => {
      // callOnNode also awaits object cleanup after reading the target state.
      signal?.throwIfAborted()
      if (tab.surface.getURL() !== sourceUrl || tab.refEpoch !== sourceRefEpoch) {
        throw new Error('Browser page changed before text entry; no text was inserted')
      }
    }
    assertDocumentUnchanged()
    const empty = await this.callOnNode<boolean | null>(
      tab,
      backendNodeId,
      `function() {
        if (!this.isConnected) throw new Error('Target text field is no longer connected');
        const tag = String(this.tagName || '').toLowerCase();
        const inputType = tag === 'input' ? String(this.type || 'text').toLowerCase() : '';
        const unsupportedInputs = new Set(['button', 'submit', 'reset', 'file', 'hidden', 'image', 'range', 'color', 'checkbox', 'radio']);
        const isTextbox = tag === 'textarea' || (tag === 'input' && !unsupportedInputs.has(inputType)) || this.isContentEditable === true;
        const ownsFocus = (${browserTextTargetOwnsFocus.toString()})(this);
        if (!isTextbox || !ownsFocus) throw new Error('Target text field did not retain focus');
        try {
          return String(this.isContentEditable === true ? this.textContent ?? '' : this.value ?? '') === '';
        } catch { return null; }
      }`,
      [],
      signal
    )
    assertDocumentUnchanged()
    return typeof empty === 'boolean' ? empty : null
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
    // Names the format a date field takes, never the value it was given.
    if (message.startsWith('Unsupported value: ')) {
      return { code: 'unsupported_control', message: message.slice('Unsupported value: '.length) }
    }
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
            const native = nativeDateFormat(before.inputType)
            // A text box that asks for a date format takes an ISO date written in it.
            const format = native ? undefined : fieldDateFormat(before.placeholder)
            const text = (format && formatDate(field.value, format)) || field.value
            sensitiveStrings.add(text)
            if (before.value !== text) {
              if (native) {
                if (!native.pattern.test(text)) {
                  throw new Error(
                    `Unsupported value: a ${before.inputType} field takes ${native.example}`
                  )
                }
                await this.setNativeInputValue(tab, backendNodeId, text, signal)
              } else {
                await this.replaceFormText(tab, target, text, initialUrl, initialRefEpoch, signal)
              }
              status = 'filled'
            }
            if (pageChanged()) throw new Error('Browser page changed while filling the form')
            const after = await this.inspectFormControl(tab, backendNodeId, signal)
            const passed = after.kind === 'textbox' && sameEnteredText(after.value, text)
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

  /** The address the session's active tab is showing, as Chromium reports it. */
  pageAddress(sessionId: string): string {
    return this.getTab(this.getSession(sessionId)).surface.getURL()
  }

  /** The WebMCP tools of the active tab's page, binding the calls that follow to this listing. */
  listWebMcpTools(sessionId: string, tabId?: string): WebMcpPageListing & { tabId: string } {
    const tab = this.getTab(this.getSession(sessionId), tabId)
    return { ...tab.webMcp.list(), tabId: tab.id }
  }

  /**
   * What a call with this input would run on the active tab, for the decision whether to ask and
   * for the approval card; throws why it would be refused, so a call bound to fail asks no one.
   */
  webMcpCallBinding(
    sessionId: string,
    origin: string,
    name: string,
    input: unknown = {}
  ): WebMcpCallBinding {
    const tab = this.getTab(this.getSession(sessionId))
    const call = this.checkedWebMcpCall(tab, origin, name, input)
    return { tabId: tab.id, document: call.document, origin, tool: { ...call.tool } }
  }

  private checkedWebMcpCall(tab: TabState, origin: string, name: string, input: unknown) {
    const call = tab.webMcp.callable(origin, name)
    const correct =
      "Correct the arguments to match the schema browser_list_webmcp_tools returned; the schema's text is the site's own."
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new WebMcpCallError(
        'invalid_arguments',
        'The arguments must be a JSON object.',
        correct
      )
    }
    const issues = call.tool.inputSchema ? externalSchemaIssues(call.tool.inputSchema, input) : []
    if (issues?.length) {
      // Paths and messages name the schema's own properties and values, which are the page's.
      throw new WebMcpCallError(
        'invalid_arguments',
        `The arguments do not fit ${name}'s input schema.`,
        correct,
        issues.slice(0, 20).map(({ path, code, message }) => ({ path, code, message }))
      )
    }
    return call
  }

  /**
   * Calls a listed WebMCP tool of the active tab's page, through Chromium as its own agent does.
   * Refused before anything runs when the page is another site's, has loaded a new document or
   * changed the tool since it was listed or since `binding` was taken, when the input does not fit
   * the tool's schema, or while a stored password is filled in on the page.
   */
  async callWebMcpTool(
    input: BrowserWebMcpCallInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserWebMcpCallResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session)
      const { tool, frameId, document } = this.checkedWebMcpCall(
        tab,
        input.origin,
        input.tool,
        input.arguments
      )
      const bound = input.binding
      if (
        bound &&
        (bound.tabId !== tab.id ||
          bound.document !== document ||
          bound.origin !== input.origin ||
          JSON.stringify(bound.tool) !== JSON.stringify(tool))
      ) {
        throw new WebMcpCallError(
          'changed',
          `The tab, its page or ${tool.name} changed after this call was checked, so it was not run.`,
          'Call browser_list_webmcp_tools again and call the tool from what the page offers now.'
        )
      }
      if (await this.secretStillOnPage(tab, signal)) {
        throw new WebMcpCallError(
          'secret_on_page',
          "A page's tools cannot be called while a stored password is filled in on the page, since the page's code could read it.",
          'Submit the sign-in form or leave the page first.'
        )
      }
      await this.assertAutomatedMutationAllowed(tab, signal)
      const startedAt = this.now()
      // Chromium starts the tool as it answers, so the call is not abandoned without its id:
      // a stopped run waits the moment it takes, then cancels the tool in the page.
      const { invocationId } = await abortable(
        tab.surface.sendDebuggerCommand<{ invocationId: string }>('WebMCP.invokeTool', {
          frameId,
          toolName: tool.name,
          input: input.arguments
        }),
        AbortSignal.timeout(10_000)
      )
      const cancel = (): void =>
        void tab.surface
          .sendDebuggerCommand('WebMCP.cancelInvocation', { invocationId })
          .catch(() => undefined)
      if (signal?.aborted) {
        cancel()
        throw abortError('Browser operation cancelled')
      }
      if (tab.webMcp.snapshot().document !== document) {
        // The page loaded another document before Chromium took the call, so it may have reached
        // a tool of the same name there, possibly another site's.
        cancel()
        throw new WebMcpCallError(
          'navigated',
          `The page loaded a new document as ${tool.name} was called; SideKick cancelled the call, which may have reached the new page.`,
          'Call browser_list_webmcp_tools again and check the page before calling anything.'
        )
      }
      const outcome = await tab.webMcp.awaitResult(invocationId, {
        form: tool.form,
        timeoutMs: WEBMCP_CALL_TIMEOUT_MS,
        signal: signal ?? new AbortController().signal
      })
      if (outcome.status === 'timeout' || outcome.status === 'cancelled') cancel()
      if (outcome.status === 'error' && outcome.exceptionObjectId) {
        void tab.surface
          .sendDebuggerCommand('Runtime.releaseObject', { objectId: outcome.exceptionObjectId })
          .catch(() => undefined)
      }
      const navigated =
        outcome.status === 'navigated' ||
        (outcome.status === 'completed' && outcome.navigatedTo !== undefined)
      if (navigated && !signal?.aborted) {
        await this.waitForQuiescence(
          tab,
          this.navigationQuiescence(tab.surface.getURL()),
          signal
        ).catch((error) => {
          if (signal?.aborted) throw error
        })
      }
      return {
        sessionId: session.id,
        tabId: tab.id,
        origin: input.origin,
        tool: {
          name: tool.name,
          readOnly: tool.readOnly,
          untrustedContent: tool.untrustedContent,
          consequential: tool.consequential,
          form: tool.form,
          autosubmit: tool.autosubmit
        },
        outcome,
        durationMs: this.now() - startedAt,
        page: { url: this.tabUrl(tab), title: tab.surface.getTitle() }
      }
    })
  }

  /**
   * Fills a stored sign-in into the current page. Values go only into fields of the top document
   * on `site`, whose form sends to that site or another of the same domain, checked again immediately
   * before each value is typed; the password only into a password field. The result has no
   * screenshot, and its semantic snapshot is redacted.
   */
  async signIn(
    input: BrowserSignInInput,
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserSignInResult> {
    if (!input.username && !input.password) throw new Error('A sign-in needs a value to fill')
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session)
      await this.assertAutomatedMutationAllowed(tab, signal)
      const startedAt = this.now()
      const initialUrl = tab.surface.getURL()
      const initialRefEpoch = tab.refEpoch
      const origin = credentialPageOrigin(initialUrl)
      if (!origin || origin !== input.site) {
        throw new Error(
          `This sign-in was approved for ${input.site || 'another page'}, and the page is no longer on it.`
        )
      }
      const domain = signInDomain(origin)
      const passwordTarget = input.password
        ? await this.signInField(tab, 'password', input.passwordTarget, signal)
        : undefined
      const usernameTarget = input.username
        ? await this.signInField(tab, 'username', input.usernameTarget, signal)
        : undefined
      if (!passwordTarget && !usernameTarget) {
        throw new Error(
          'No sign-in field was found on this page. Observe it and pass username_ref or password_ref.'
        )
      }
      const check = async (target: ElementPoint, kind: 'username' | 'password'): Promise<void> => {
        const facts = await this.callOnNode<SignInFieldFacts>(
          tab,
          target.backendNodeId!,
          `function() {
            const form = this.form;
            let formOrigin = null;
            if (form) {
              try {
                formOrigin = new URL(form.getAttribute('action') || this.ownerDocument.location.href, this.ownerDocument.baseURI).origin;
              } catch { formOrigin = 'invalid'; }
            }
            return {
              connected: this.isConnected === true,
              tag: String(this.tagName || '').toLowerCase(),
              type: String(this.getAttribute('type') || 'text').toLowerCase(),
              topFrame: this.ownerDocument.defaultView === window.top,
              origin: this.ownerDocument.location.origin,
              formOrigin,
              disabled: this.disabled === true,
              readOnly: this.readOnly === true
            };
          }`,
          [],
          signal
        )
        if (tab.surface.getURL() !== initialUrl || tab.refEpoch !== initialRefEpoch) {
          throw new Error('The page changed during sign-in; observe it before trying again')
        }
        if (!facts.connected || facts.tag !== 'input' || facts.disabled || facts.readOnly) {
          throw new Error(`The ${kind} field is not an editable input`)
        }
        if (!facts.topFrame) throw new Error('A sign-in is never filled into a frame')
        const fieldOrigin = credentialPageOrigin(facts.origin)
        if (fieldOrigin !== origin) throw new Error(`The ${kind} field belongs to another site`)
        if (facts.formOrigin !== null) {
          const target =
            facts.formOrigin === 'invalid' ? null : credentialPageOrigin(facts.formOrigin)
          if (!target || !sameSignInSite(origin, domain, target)) {
            throw new Error('The sign-in form sends to another site, so it was not filled')
          }
        }
        if (kind === 'password' && facts.type !== 'password') {
          throw new Error('A password goes only into a password field')
        }
        if (kind === 'username' && !['text', 'email', 'tel'].includes(facts.type)) {
          throw new Error('The username field is not a text or email field')
        }
      }
      const filled: Array<'username' | 'password'> = []
      let fillUsername = Boolean(usernameTarget && input.username)
      if (fillUsername) {
        try {
          await check(usernameTarget!, 'username')
        } catch (error) {
          // A field SideKick found itself, such as a read-only username shown on a password step,
          // is left alone when there is a password to fill; one the agent named must be right.
          if (input.usernameTarget || !passwordTarget) throw error
          fillUsername = false
        }
      }
      if (fillUsername) {
        await this.replaceFormText(
          tab,
          usernameTarget!,
          input.username!,
          initialUrl,
          initialRefEpoch,
          signal
        )
        filled.push('username')
      }
      if (passwordTarget && input.password) {
        await check(passwordTarget, 'password')
        // Marked before typing, so nothing can capture the field between typing and marking.
        tab.secretFields = [...(tab.secretFields ?? []), passwordTarget.backendNodeId!]
        await this.replaceFormText(
          tab,
          passwordTarget,
          input.password,
          initialUrl,
          initialRefEpoch,
          signal
        )
        filled.push('password')
      }
      let submitted = false
      if (input.submit) {
        if (tab.surface.getURL() !== initialUrl || tab.refEpoch !== initialRefEpoch) {
          throw new Error('The page changed during sign-in; it was not submitted')
        }
        const last = (passwordTarget ?? usernameTarget)!
        // The form's own submission, as its default button would send it; a page without a form
        // gets Enter in the field it listens to. Its target is read again in the same step, since
        // page script could have changed it after the fields were checked; a refused submission
        // takes the typed password back out.
        const submission = await this.callOnNode<'form' | 'none' | 'refused'>(
          tab,
          last.backendNodeId!,
          `function(site, domain, clear) {
            const form = this.form;
            if (!form) return 'none';
            let target = null;
            try {
              target = new URL(form.getAttribute('action') || this.ownerDocument.location.href, this.ownerDocument.baseURI);
            } catch {}
            const sameSite = Boolean(target) && (target.origin === site || (domain !== null &&
              target.protocol === 'https:' && !target.port &&
              (target.hostname === domain || target.hostname.endsWith('.' + domain))));
            if (!sameSite) {
              if (clear) this.value = '';
              return 'refused';
            }
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
            return 'form';
          }`,
          [origin, domain, last === passwordTarget],
          signal
        )
        if (submission === 'refused') {
          throw new Error('The sign-in form now sends to another site, so it was not submitted')
        }
        if (submission === 'none') {
          tab.surface.focus()
          tab.surface.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          tab.surface.sendInputEvent({ type: 'char', keyCode: '\r' })
          tab.surface.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        }
        await abortable(tab.surface.executeJavaScript('0'), signal).catch(() => undefined)
        submitted = true
      }
      const quiescence = await this.waitForQuiescence(tab, {}, signal)
      const observation = redactFormObservation(
        await this.observeUnlocked(
          session,
          { tabId: tab.id, screenshot: 'none', includeSemanticSnapshot: true },
          signal
        ),
        new Set([input.username ?? '', input.password ?? ''].filter(Boolean))
      )
      return {
        sessionId: session.id,
        tabId: tab.id,
        action: 'sign_in',
        targetMode: (passwordTarget ?? usernameTarget)!.mode,
        coordinateFallbackUsed: false,
        durationMs: this.now() - startedAt,
        quiescence,
        loopProtection: { unchangedRepeatCount: 0, blockedOnNextIdenticalAction: false },
        observation,
        origin,
        filled,
        submitted
      }
    })
  }

  /** A sign-in field by the agent's target, or found on the page; undefined when there is none. */
  private async signInField(
    tab: TabState,
    kind: 'username' | 'password',
    target: BrowserTarget | undefined,
    signal?: AbortSignal
  ): Promise<ElementPoint | undefined> {
    if (target) {
      const point = await this.resolveTarget(tab, target, false, signal)
      if (!point.backendNodeId) throw new Error(`The ${kind} field could not be resolved`)
      return point
    }
    const found = await abortable(
      tab.surface.sendDebuggerCommand<{ result?: { objectId?: string; subtype?: string } }>(
        'Runtime.evaluate',
        { expression: `(${FIND_SIGN_IN_FIELD})(${JSON.stringify(kind)})`, returnByValue: false }
      ),
      signal
    ).catch((error: unknown) => {
      throw pageChangedError(error)
    })
    const objectId = found.result?.objectId
    if (!objectId || found.result?.subtype === 'null') return undefined
    try {
      const described = await abortable(
        tab.surface.sendDebuggerCommand<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
          objectId
        }),
        signal
      ).catch((error: unknown) => {
        throw pageChangedError(error)
      })
      const backendNodeId = described.node?.backendNodeId
      if (!backendNodeId) return undefined
      const rect = await this.elementRect(tab, backendNodeId, signal)
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        backendNodeId,
        mode: 'semantic',
        fallbackUsed: false
      }
    } finally {
      await tab.surface
        .sendDebuggerCommand('Runtime.releaseObject', { objectId })
        .catch(() => undefined)
    }
  }

  /** The state of each password field a sign-in filled that this document still has. */
  private async secretFieldStates(
    tab: TabState,
    signal?: AbortSignal
  ): Promise<Array<{ isPassword: boolean; hasValue: boolean }>> {
    if (!tab.secretFields?.length) return []
    const states: Array<{ isPassword: boolean; hasValue: boolean }> = []
    const kept: number[] = []
    for (const backendNodeId of tab.secretFields) {
      try {
        const state = await this.callOnNode<{
          connected: boolean
          isPassword: boolean
          hasValue: boolean
        }>(
          tab,
          backendNodeId,
          `function() {
            return {
              connected: this.isConnected === true,
              isPassword: String(this.getAttribute('type') || '').toLowerCase() === 'password' && this.type === 'password',
              hasValue: String(this.value || '') !== ''
            };
          }`,
          [],
          signal
        )
        if (!state.connected || !state.hasValue) continue
        kept.push(backendNodeId)
        states.push(state)
      } catch {
        // The node belongs to a document the tab has left, so it no longer holds the value.
      }
    }
    tab.secretFields = kept
    return states
  }

  private async secretShownAsText(tab: TabState, signal?: AbortSignal): Promise<boolean> {
    return (await this.secretFieldStates(tab, signal)).some((state) => !state.isPassword)
  }

  private async secretStillOnPage(tab: TabState, signal?: AbortSignal): Promise<boolean> {
    return (await this.secretFieldStates(tab, signal)).length > 0
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
      const kind = await this.callOnNode<PickerKind>(
        tab,
        target.backendNodeId!,
        PICKER_PAGE_FUNCTION,
        [{ phase: 'detect' }],
        signal
      )
      if (kind !== 'select') {
        await this.pickValues(tab, target, kind, input.values, signal)
        return this.finishAction(
          session,
          tab,
          'select',
          target.mode,
          false,
          fingerprint,
          startedAt,
          signal
        )
      }
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
      // `observation.tab.url` intentionally exposes the original file:// URL
      // while a local PDF is rendered through the private sidekick-pdf://
      // surface. Compare the actual WebContents URL here so a successful PDF
      // selection is not mistaken for navigation.
      if (tab.surface.getURL() !== sourceUrl || tab.refEpoch !== sourceRefEpoch) {
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

  /**
   * Chooses each value in a picker the page builds itself, as a person would: opens it or types
   * into it, waits for its options to settle, clicks the one option the value names, confirms a
   * dialog, and checks the control shows the choice. See browserPicker.ts.
   */
  private async pickValues(
    tab: TabState,
    control: ElementPoint,
    kind: Exclude<PickerKind, 'select'>,
    values: string[],
    signal?: AbortSignal
  ): Promise<void> {
    const picked: PickerOption[] = []
    for (const wanted of values) {
      // An earlier pick can move the control, as a chip added beside it does.
      const rect = await this.elementRect(tab, control.backendNodeId!, signal)
      const at = { ...control, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      picked.push(await this.pickValue(tab, at, kind, wanted, signal))
    }
    if (picked.length < 2) return
    // A later pick can replace an earlier one in a picker that holds a single value.
    const readback = await this.pickerCall<{ own: string; around: string }>(
      tab,
      control,
      randomUUID(),
      'readback',
      {},
      signal
    )
    const lost = picked.filter((option) => !showsChoice(readback, option.names))
    if (lost.length) {
      throw new Error(
        `The picker kept only some of the requested values; it no longer shows ${lost.map((option) => JSON.stringify(option.label)).join(', ')}`
      )
    }
  }

  private async pickValue(
    tab: TabState,
    control: ElementPoint,
    kind: Exclude<PickerKind, 'select'>,
    wanted: string,
    signal?: AbortSignal
  ): Promise<PickerOption> {
    const token = randomUUID()
    const call = <T>(phase: string, extra: Record<string, unknown> = {}): Promise<T> =>
      this.pickerCall<T>(tab, control, token, phase, extra, signal)
    // A picker often rewrites the address as it goes without leaving the page, so only a page
    // that is gone stops it; a new document fails every call on the control. Each entry of text
    // is still bound to the address it starts on.
    const enter = (field: ElementPoint, text: string): Promise<void> =>
      this.replaceFormText(tab, field, text, tab.surface.getURL(), tab.refEpoch, signal)
    try {
      if (kind === 'datalist') {
        const options = await call<PickerOption[]>('datalist')
        const option = this.pickerChoice(options, wanted)
        await enter(control, option.value)
        const after = await this.inspectFormControl(tab, control.backendNodeId!, signal)
        if (after.value !== option.value) {
          throw new Error('The field did not keep the chosen suggestion')
        }
        return option
      }
      await call('snapshot')
      const since = this.now()
      let field = control
      if (kind === 'typeahead') {
        // A field that opens an overlay with a text box of its own takes the typing there, once
        // the overlay has finished opening.
        await this.clickFormControl(tab, control, signal)
        let moved: number | undefined
        for (let attempt = 0; attempt < 20 && !moved; attempt++) {
          await delay(50, signal)
          moved = await this.pickerNode(tab, control, token, 'focused-node', signal)
        }
        if (moved) {
          await delay(250, signal)
          field = await this.pointOfNode(tab, moved, signal)
        }
      } else if (!(await call<boolean>('open'))) {
        // A list the model already opened stays open; clicking its control again would close it.
        await this.clickFormControl(tab, control, signal)
      }
      // A site searches by a shorter text than an option's whole label, as a model often passes:
      // the full value first, then its text before the first comma, then its first word. Every
      // list is ranked against the full value.
      const queries = [
        ...new Set(
          [wanted, wanted.split(',')[0], wanted.split(/\s+/)[0]].map((query) => query.trim())
        )
      ].filter((query) => query.length >= 2)
      let scan: PickerScan | undefined
      let ranking: ReturnType<typeof rankChoices> = { status: 'missing' }
      for (const [attempt, query] of queries.entries()) {
        if (kind === 'typeahead') {
          await enter(field, query)
        } else if (attempt > 0 || scan) {
          // A list whose first view lacks the value, or holds it only among other words, is
          // narrowed with the search box it brings.
          if (!scan?.search) break
          const search = await this.pickerNode(tab, control, token, 'search-node', signal)
          if (!search) break
          await enter(await this.pointOfNode(tab, search, signal), query)
        }
        const typed = kind === 'typeahead' || attempt > 0 ? query : undefined
        scan = await this.pickerSettle(tab, control, token, since, signal, typed)
        ranking = rankChoices(scan.options, [wanted])
        const narrow =
          ranking.status === 'missing' || ('rank' in ranking && ranking.rank === 'words')
        // A dropdown is first read as it opens, before anything is typed into its search box.
        if (kind !== 'typeahead' && attempt === 0 && narrow && scan.search) {
          const search = await this.pickerNode(tab, control, token, 'search-node', signal)
          if (search) {
            await enter(await this.pointOfNode(tab, search, signal), query)
            scan = await this.pickerSettle(tab, control, token, since, signal, query)
            ranking = rankChoices(scan.options, [wanted])
          }
        }
        if (ranking.status !== 'missing') break
      }
      if (!scan) throw new Error('The control opened no list of options')
      if (!scan.popup) {
        throw new Error(
          'The control opened no list of options; observe the page and choose the option directly'
        )
      }
      const option = this.pickerChoice(scan.options, wanted, ranking)
      const index = scan.options.indexOf(option)
      const before = await call<{ own: string; around: string }>('readback')
      const point = await call<{ x: number; y: number } | null>('point', {
        which: 'option',
        index
      })
      if (!point) throw new Error('The chosen option disappeared before it could be clicked')
      await this.clickFormControl(
        tab,
        { ...point, mode: control.mode, fallbackUsed: false },
        signal
      )
      // A click counts once the page shows it did something: the option or its list went away,
      // or the option became selected. A field holding the typed text already shows the label.
      const typedAlready = showsChoice(before, option.names)
      const deadline = this.now() + 3_000
      let confirmed = false
      while (true) {
        await delay(100, signal)
        if (tab.surface.isDestroyed())
          throw new Error('Browser page closed while choosing an option')
        const after = await call<{ gone: boolean; closed: boolean; selected: boolean }>('after', {
          index
        })
        // A dialog's row is often only highlighted until its Select or OK button is pressed.
        if (scan.dialog && !after.closed && !confirmed) {
          const again = await call<PickerScan>('scan')
          const confirm = again.confirm
            ? await call<{ x: number; y: number } | null>('point', { which: 'confirm' })
            : null
          if (confirm) {
            await this.clickFormControl(
              tab,
              { ...confirm, mode: control.mode, fallbackUsed: false },
              signal
            )
            confirmed = true
            continue
          }
        }
        const readback = await call<{ own: string; around: string }>('readback')
        if (
          showsChoice(readback, option.names) &&
          (!typedAlready || after.gone || after.closed || after.selected)
        ) {
          return option
        }
        if (this.now() >= deadline) {
          throw new Error(
            `The control did not keep ${JSON.stringify(option.label)} after it was clicked; observe the page before retrying`
          )
        }
      }
    } catch (error) {
      // Leaves the page as it was found rather than with a list hanging open: Escape, or, for a
      // menu that ignores it, the control that opened it.
      if (!tab.surface.isDestroyed()) {
        tab.surface.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        tab.surface.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        if (kind === 'dropdown') {
          await delay(100, signal).catch(() => undefined)
          const open = await call<{ closed: boolean }>('after', { index: -1 }).catch(() => null)
          if (open && !open.closed)
            await this.clickFormControl(tab, control, signal).catch(() => undefined)
        }
      }
      throw error
    } finally {
      await call('cleanup').catch(() => undefined)
    }
  }

  private pickerCall<T>(
    tab: TabState,
    control: ElementPoint,
    token: string,
    phase: string,
    extra: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    return this.callOnNode<T>(
      tab,
      control.backendNodeId!,
      PICKER_PAGE_FUNCTION,
      [{ ...extra, token, phase }],
      signal
    )
  }

  /** The option `wanted` names, or an error that lists what the picker offers instead. */
  private pickerChoice(
    options: PickerOption[],
    wanted: string,
    ranking = rankChoices(options, [wanted])
  ): PickerOption {
    const safe = (text: string): string => JSON.stringify(text.slice(0, 80))
    if (ranking.status === 'picked') return options[ranking.index]
    if (ranking.status === 'disabled') {
      throw new Error(`The option ${safe(options[ranking.index].label)} is disabled`)
    }
    if (ranking.status === 'ambiguous') {
      const tied = ranking.indexes.slice(0, 8).map((index) => options[index])
      // Options that share a label, such as two places called Lisbon, are told apart by their
      // whole text, which also picks one when passed back.
      const label = (option: PickerOption): string =>
        tied.filter((other) => other.label === option.label).length > 1
          ? option.names.reduce((long, name) => (name.length > long.length ? name : long))
          : option.label
      throw new Error(
        `${safe(wanted)} matches several options: ${tied.map((option) => safe(label(option))).join(', ')}. Pass the exact label of one.`
      )
    }
    const available = options.filter((option) => !option.disabled && !option.echo).slice(0, 20)
    throw new Error(
      available.length
        ? `No option matched ${safe(wanted)}. Options listed: ${available.map((option) => safe(option.label)).join(', ')}${options.length > available.length ? ', ...' : ''}`
        : `The picker listed no options for ${safe(wanted)}`
    )
  }

  /**
   * The picker's options once they hold still: no loading sign, no request since the pick began,
   * and the same options for a moment. An empty list is waited on a little longer, since a
   * typeahead often asks the server only after a pause in typing.
   */
  private async pickerSettle(
    tab: TabState,
    control: ElementPoint,
    token: string,
    since: number,
    signal?: AbortSignal,
    typed?: string
  ): Promise<PickerScan> {
    const startedAt = this.now()
    let last: PickerScan | undefined
    let stableSince = startedAt
    // After typing, a list none of whose options mention what was typed, such as a calendar
    // that opened beside the field, is waited past like an empty one.
    const word = foldChoiceText(typed ?? '').split(' ')[0]
    const answers = (scan: PickerScan): boolean =>
      !word ||
      scan.options.some((option) =>
        option.names.some((name) => ` ${foldChoiceText(name)}`.includes(` ${word}`))
      )
    while (true) {
      const scan = await this.pickerCall<PickerScan>(tab, control, token, 'scan', {}, signal)
      const now = this.now()
      if (
        !last ||
        scan.signature !== last.signature ||
        scan.loading ||
        busyRequests(tab.inFlight.values(), since, now) > 0
      ) {
        stableSince = now
      }
      last = scan
      if (
        now - stableSince >= 400 &&
        ((scan.options.length && answers(scan)) || now - startedAt >= 2_500)
      )
        return scan
      if (now - startedAt >= 8_000) return scan
      await delay(100, signal)
    }
  }

  /** A node the picker's page code found, such as its search box, for text entry to target. */
  private async pickerNode(
    tab: TabState,
    control: ElementPoint,
    token: string,
    phase: 'search-node' | 'focused-node',
    signal?: AbortSignal
  ): Promise<number | undefined> {
    const objectId = await this.resolvedNodeObject(tab, control.backendNodeId!, signal)
    let searchId: string | undefined
    try {
      const response = await abortable(
        tab.surface.sendDebuggerCommand<{ result?: { objectId?: string } }>(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: PICKER_PAGE_FUNCTION,
            arguments: [{ value: { token, phase } }],
            returnByValue: false
          }
        ),
        signal
      )
      searchId = response.result?.objectId
      if (!searchId) return undefined
      const described = await abortable(
        tab.surface.sendDebuggerCommand<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
          objectId: searchId
        }),
        signal
      )
      return described.node?.backendNodeId
    } finally {
      for (const id of [objectId, searchId]) {
        if (id) {
          await tab.surface
            .sendDebuggerCommand('Runtime.releaseObject', { objectId: id })
            .catch(() => undefined)
        }
      }
    }
  }

  private async pointOfNode(
    tab: TabState,
    backendNodeId: number,
    signal?: AbortSignal
  ): Promise<ElementPoint> {
    const rect = await this.elementRect(tab, backendNodeId, signal)
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      backendNodeId,
      mode: 'selector',
      fallbackUsed: false
    }
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
      const mobile = input.emulation?.mobile === true
      await abortable(
        tab.surface.setAgentViewport
          ? tab.surface.setAgentViewport(viewport, {
              mobile,
              ...(mobile ? { userAgent: mobileUserAgent(input.emulation?.tablet === true) } : {})
            })
          : tab.surface.sendDebuggerCommand('Emulation.setDeviceMetricsOverride', {
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
      tab.device = {
        id: input.device?.id ?? 'custom',
        label: input.device?.label ?? `${viewport.width} × ${viewport.height}`,
        source: input.device?.source ?? 'agent',
        width: viewport.width,
        height: viewport.height
      }
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

  /** Returns a tab to the size of where it is shown, as a normal browser window. */
  async resetViewport(
    input: { sessionId: string; tabId?: string },
    operation: BrowserOperationOptions = {}
  ): Promise<BrowserActionResult> {
    const session = this.getSession(input.sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session, input.tabId)
      const fingerprint = canonicalFingerprint({ action: 'reset-viewport', tabId: tab.id })
      await this.ensureBaselineHash(session, tab, signal)
      const startedAt = this.now()
      tab.lastPointer = undefined
      await abortable(
        tab.surface.clearAgentViewport
          ? tab.surface.clearAgentViewport()
          : tab.surface.sendDebuggerCommand('Emulation.clearDeviceMetricsOverride'),
        signal
      )
      tab.surface.resizeViewport(this.defaultViewport)
      tab.device = undefined
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

  /** Tabs the agent left at a fixed size, so its reply can hand them back responsive. */
  agentSizedTabs(sessionId: string): string[] {
    const session = this.getSession(sessionId)
    return [...session.tabs.values()]
      .filter((tab) => tab.device?.source === 'agent')
      .map((tab) => tab.id)
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
    tab.surface.showPointer?.(target.x, target.y)
  }

  /**
   * Waits until what the latest action set off has finished: its requests, the changes it made and
   * any loading sign it brought up, ignoring the page's own background activity. See
   * browserSettle.ts.
   */
  private async waitForQuiescence(
    tab: TabState,
    input: { idleMs?: number; maxWaitMs?: number },
    signal?: AbortSignal
  ): Promise<BrowserQuiescenceResult> {
    const idleMs = boundedInteger(input.idleMs ?? 350, 50, 5_000, 'idleMs')
    const maxWaitMs = boundedInteger(input.maxWaitMs ?? 5_000, idleMs, 30_000, 'maxWaitMs')
    const startedAt = this.now()
    const mark =
      tab.settleMark && startedAt - tab.settleMark.at < 60_000 ? tab.settleMark : undefined
    const since = mark?.at ?? startedAt
    // A page can answer anything; what is not a count reads as no change and no loading sign.
    const probe = async (): Promise<{ changes?: number; loading?: number }> => {
      const state = await abortable(
        tab.surface.executeJavaScript<unknown>(settleProbeScript(mark)),
        signal
      ).catch(() => undefined)
      const count = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined
      return state && typeof state === 'object'
        ? {
            changes: count((state as { changes?: unknown }).changes),
            loading: count((state as { loading?: unknown }).loading)
          }
        : {}
    }
    let stableSince = startedAt
    let changes = (await probe()).changes ?? 0
    let pending = 0
    while (this.now() - startedAt < maxWaitMs) {
      const state = await probe()
      pending = busyRequests(tab.inFlight.values(), since, this.now())
      if (
        (state.changes ?? changes) !== changes ||
        (state.loading ?? 0) > 0 ||
        pending > 0 ||
        tab.surface.isLoading()
      ) {
        changes = state.changes ?? changes
        stableSince = this.now()
      } else if (this.now() - stableSince >= idleMs) {
        return {
          idle: true,
          waitedMs: this.now() - startedAt,
          pendingRequests: pending,
          mutationRevision: changes,
          timedOut: false
        }
      }
      await delay(50, signal)
    }
    return {
      idle: false,
      waitedMs: this.now() - startedAt,
      pendingRequests: pending,
      mutationRevision: changes,
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
          ? await this.normalizeNavigationUrl(input.url, session.allowedFileRoots, signal)
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
    await this.cleanupTemporaryPdfSources(tab)
    const errors: unknown[] = []
    for (const dispose of tab.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        tab.disposers.push(dispose)
        errors.push(error)
      }
    }
    try {
      await tab.surface.close()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) {
      // Teardown may fail even after a destruction callback; preserve retry ownership.
      session.tabs.set(tab.id, tab)
      if (this.sessions.get(session.id) !== session) this.retiredSessions.add(session)
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Browser tab cleanup failed')
    }
    session.tabs.delete(tab.id)
    if (session.activeTabId === tab.id) session.activeTabId = session.tabs.keys().next().value ?? ''
    if (!session.tabs.size) {
      this.retireSession(session)
    }
  }

  private async closeSessionTabs(session: SessionState): Promise<void> {
    const errors: unknown[] = []
    for (const tab of [...session.tabs.values()]) {
      try {
        await this.closeTab(session, tab)
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await this.cleanupPendingTabs(session)
    } catch (error) {
      errors.push(error)
    }
    this.retireSession(session)
    if (errors.length) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Browser session cleanup failed')
    }
  }

  private async cleanupPendingTabs(session: SessionState): Promise<void> {
    const errors: unknown[] = []
    for (const reservation of [...session.pendingTabs]) {
      reservation.abandoned = true
      try {
        await abortable(this.cleanupOpening(reservation), AbortSignal.timeout(2_000))
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Browser tab creation cleanup failed')
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
      if (await this.secretStillOnPage(tab, signal)) {
        throw new Error(
          'browser_evaluate is unavailable while a stored password is filled in on this page, since page script could read it. Submit the form or leave the page first.'
        )
      }
      await this.assertAutomatedMutationAllowed(tab, signal)
      const envelope = await this.evaluateExpression(tab, input.expression, signal)
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

  /**
   * Runs the expression as DevTools' console does, through the protocol rather than `eval` in
   * the page, so a page whose Content Security Policy or Trusted Types forbid `eval` can still be
   * read. REPL mode keeps statements, top-level `await` and the last expression's value.
   */
  private async evaluateExpression(
    tab: TabState,
    expression: string,
    signal?: AbortSignal
  ): Promise<{ json: string; truncated: boolean }> {
    const evaluated = await abortable(
      tab.surface.sendDebuggerCommand<{
        result?: {
          objectId?: string
          subtype?: string
          value?: unknown
          unserializableValue?: string
        }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>('Runtime.evaluate', {
        expression,
        replMode: true,
        awaitPromise: true,
        returnByValue: false,
        userGesture: true
      }),
      signal
    ).catch((error: unknown) => {
      throw pageChangedError(error)
    })
    if (evaluated.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description ??
          evaluated.exceptionDetails.text ??
          'Browser page evaluation failed'
      )
    }
    const result = evaluated.result ?? {}
    const bounded = (json: string): { json: string; truncated: boolean } =>
      json.length > MAX_EVALUATION_BYTES
        ? { json: json.slice(0, MAX_EVALUATION_BYTES), truncated: true }
        : { json, truncated: false }
    if (!result.objectId) {
      const value = result.unserializableValue ?? result.value ?? null
      return bounded(JSON.stringify(value) ?? 'null')
    }
    try {
      const serialized = await abortable(
        tab.surface.sendDebuggerCommand<{
          result?: { value?: { json: string; truncated: boolean } }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }>('Runtime.callFunctionOn', {
          objectId: result.objectId,
          functionDeclaration: `async function(limit) {
            let value = this;
            if (value && typeof value.then === 'function') value = await value;
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
            const truncated = json.length > limit;
            return { json: truncated ? json.slice(0, limit) : json, truncated };
          }`,
          arguments: [{ value: MAX_EVALUATION_BYTES }],
          awaitPromise: true,
          returnByValue: true
        }),
        signal
      ).catch((error: unknown) => {
        throw pageChangedError(error)
      })
      if (serialized.exceptionDetails || !serialized.result?.value) {
        throw new Error(
          serialized.exceptionDetails?.exception?.description ??
            serialized.exceptionDetails?.text ??
            'The evaluated value could not be read'
        )
      }
      return serialized.result.value
    } finally {
      await tab.surface
        .sendDebuggerCommand('Runtime.releaseObject', { objectId: result.objectId })
        .catch(() => undefined)
    }
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

  /**
   * Whether the active tab still shows a human check. Once the user has cleared it, refs from
   * before their clicks are dropped and the page has settled.
   */
  async humanVerificationRequired(
    sessionId: string,
    operation: BrowserOperationOptions = {}
  ): Promise<boolean> {
    const session = this.getSession(sessionId)
    return this.withSessionLock(session, operation, async (signal) => {
      const tab = this.getTab(session)
      if (await this.detectHumanVerification(tab, undefined, signal)) return true
      this.invalidateSemanticRefs(tab)
      await this.waitForQuiescence(tab, { idleMs: 200, maxWaitMs: 2_000 }, signal)
      return false
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
        if (session.tabs.size === 1) this.retireSession(session)
        closedTabs.push(tab.id)
        await this.closeTab(session, tab)
        if (this.sessions.get(session.id) !== session) await this.cleanupPendingTabs(session)
        if (input.deleteArtifacts) await this.deleteTabArtifacts(session, tab.id)
      } else {
        // Direct close bypasses the operation queue: retire before any cleanup await.
        this.retireSession(session)
        closedTabs.push(...session.tabs.keys())
        await this.closeSessionTabs(session)
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
    const sessions = new Set([...this.sessions.values(), ...this.retiredSessions])
    for (const session of sessions) this.retireSession(session)
    const errors: unknown[] = []
    for (const session of sessions) {
      try {
        await this.closeSessionTabs(session)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const reservation of this.openingReservations) {
      if (!reservation.abandoned) continue
      try {
        await abortable(this.cleanupOpening(reservation), AbortSignal.timeout(2_000))
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Browser cleanup failed')
    }
  }
}
