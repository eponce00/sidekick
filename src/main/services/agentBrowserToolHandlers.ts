import { resolve } from 'path'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  MAX_TOOL_RESULT_MEDIA_BYTES,
  type ToolExecutionResult,
  type ToolResultMediaAttachment
} from '../../shared/agentRuntime'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ToolOutputStore } from './toolOutputStore'
import {
  NativeBrowserSessionService,
  type BrowserActionResult,
  type BrowserFillFormResult,
  type BrowserFormFieldInput,
  type BrowserNavigateInput,
  type BrowserObservation,
  type BrowserScreenshotArtifact,
  type BrowserTarget,
  type BrowserWaitCondition
} from './nativeBrowserSessionService'

export const AGENT_BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_observe',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_fill_form',
  'browser_press',
  'browser_scroll',
  'browser_hover',
  'browser_wait',
  'browser_navigate',
  'browser_resize',
  'browser_tabs',
  'browser_console',
  'browser_network',
  'browser_evaluate',
  'browser_verify',
  'browser_close'
] as const

const DEFAULT_MAX_CONVERSATION_SESSIONS = 6
const MAX_PERSISTED_SEMANTIC_LINES = 300
const MAX_ACTION_SEMANTIC_LINES = 120
const MAX_PERSISTED_TELEMETRY = 100

const PRIMARY_SEMANTIC_ROLES = new Set([
  'alert',
  'button',
  'checkbox',
  'combobox',
  'dialog',
  'link',
  'listbox',
  'menuitem',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'textbox',
  'treeitem'
])
const CONTEXT_SEMANTIC_ROLES = new Set([
  'form',
  'group',
  'heading',
  'main',
  'navigation',
  'region',
  'row',
  'rowheader',
  'table'
])

interface BrowserScopeEntry {
  sessionId: string
  lastUsed: number
  active: number
  consoleCursor: number
  networkCursor: number
  workspaceRootKey: string
}

interface BrowserSessionLease {
  sessionId: string
  entry: BrowserScopeEntry
  release: () => Promise<void>
}

export interface AgentBrowserToolHandlerOptions {
  maxConversationSessions?: number
  now?: () => number
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const FORBIDDEN_BROWSER_EVALUATION_PATTERNS: Array<{
  pattern: RegExp
  action: string
  tool: string
}> = [
  {
    pattern: /\.dispatchEvent\s*\(/i,
    action: 'dispatch synthetic events',
    tool: 'browser_click, browser_type, or browser_press'
  },
  { pattern: /\.click\s*\(/i, action: 'click elements', tool: 'browser_click' },
  {
    pattern: /\b(?:scrollBy|scrollTo)\s*\(/i,
    action: 'scroll the page',
    tool: 'browser_scroll'
  },
  {
    pattern: /\.(?:focus|blur)\s*\(/i,
    action: 'change focus',
    tool: 'browser_click or browser_press'
  },
  {
    pattern: /\.(?:submit|requestSubmit)\s*\(/i,
    action: 'submit forms',
    tool: 'browser_type or browser_press'
  },
  {
    pattern: /\b(?:KeyboardEvent|MouseEvent|PointerEvent|InputEvent|WheelEvent)\s*\(/,
    action: 'construct synthetic input events',
    tool: 'the dedicated browser action tools'
  },
  {
    pattern: /\.classList\.(?:add|remove|replace|toggle)\s*\(/i,
    action: 'mutate element classes',
    tool: 'browser_click or another real browser action'
  },
  {
    pattern:
      /\.(?:setAttribute|removeAttribute|append|appendChild|prepend|remove|replaceWith|insertAdjacentHTML)\s*\(/i,
    action: 'mutate the DOM',
    tool: 'a real browser action or workspace editing tool'
  }
]

function assertBrowserEvaluationIsInspectionOnly(expression: string): void {
  const forbidden = FORBIDDEN_BROWSER_EVALUATION_PATTERNS.find(({ pattern }) =>
    pattern.test(expression)
  )
  if (!forbidden) return
  throw new Error(
    `browser_evaluate must be inspection-only and cannot ${forbidden.action}. Use ${forbidden.tool} instead.`
  )
}

function browserScope(context: AgentToolExecutionContext): string {
  return context.conversationId?.trim() || context.runId
}

function workspaceRootKey(root: string | undefined): string {
  if (!root) return ''
  const normalized = resolve(root)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized
}

function isMissingSessionError(error: unknown): boolean {
  return /browser session not found|already closed/i.test(
    error instanceof Error ? error.message : String(error)
  )
}

function withoutArtifactPath(
  artifact: BrowserScreenshotArtifact
): Omit<BrowserScreenshotArtifact, 'path'> {
  const { path: _path, ...publicArtifact } = artifact
  return publicArtifact
}

function semanticRole(line: string): string {
  return /^\s*-\s+([^\s]+)/.exec(line)?.[1]?.toLowerCase() ?? ''
}

/**
 * Keep actionable nodes from the entire accessibility tree instead of blindly
 * taking its head. Long selects can otherwise spend the whole model budget on
 * options near the top of a form and hide later fields and submit buttons.
 */
function prioritizedSemanticSnapshot(snapshot: string, lineLimit: number): string {
  const lines = snapshot.split('\n')
  if (lines.length <= lineLimit) return snapshot
  const ranked = lines.map((line, index) => {
    const role = semanticRole(line)
    let priority = 5
    if (PRIMARY_SEMANTIC_ROLES.has(role)) priority = 0
    else if (CONTEXT_SEMANTIC_ROLES.has(role)) priority = 1
    else if (/\b(?:checked|selected|required|expanded|pressed|disabled)=/i.test(line)) priority = 2
    else if (role === 'option') priority = 3
    else if (role === 'statictext' || role === 'inlinetextbox') priority = 4
    return { line, index, priority }
  })
  const selected = ranked
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, Math.max(1, lineLimit - 1))
    .sort((left, right) => left.index - right.index)
  return `${selected.map(({ line }) => line).join('\n')}\n... semantic snapshot prioritized and limited by SideKick ...`
}

function publicObservation(observation: BrowserObservation, semanticLineLimit?: number): unknown {
  const lineLimit = Math.max(
    1,
    Math.min(MAX_PERSISTED_SEMANTIC_LINES, semanticLineLimit ?? MAX_PERSISTED_SEMANTIC_LINES)
  )
  const lines = observation.semanticSnapshot?.split('\n')
  const semanticSnapshot = lines
    ? lines.length > lineLimit
      ? prioritizedSemanticSnapshot(observation.semanticSnapshot!, lineLimit)
      : observation.semanticSnapshot
    : undefined
  return {
    ...observation,
    ...(semanticSnapshot === undefined ? {} : { semanticSnapshot }),
    ...(observation.screenshot ? { screenshot: withoutArtifactPath(observation.screenshot) } : {}),
    console: observation.console.slice(-MAX_PERSISTED_TELEMETRY),
    failedRequests: observation.failedRequests.slice(-MAX_PERSISTED_TELEMETRY)
  }
}

function compactObservation(
  observation: BrowserObservation,
  screenshotAttached: boolean,
  semanticLineLimit = MAX_ACTION_SEMANTIC_LINES
): unknown {
  const semanticSnapshot = observation.semanticSnapshot
    ? prioritizedSemanticSnapshot(observation.semanticSnapshot, semanticLineLimit)
    : undefined
  return {
    observedAt: observation.observedAt,
    tab: {
      id: observation.tab.id,
      title: observation.tab.title,
      url: observation.tab.url,
      loading: observation.tab.loading
    },
    viewport: observation.viewport,
    pointer: observation.pointer ?? null,
    ...(semanticSnapshot ? { semanticSnapshot } : {}),
    semanticNodeCount: observation.semanticNodeCount,
    visual: observation.screenshot
      ? {
          screenshotId: observation.screenshot.id,
          width: observation.screenshot.width,
          height: observation.screenshot.height,
          sha256: observation.screenshot.sha256,
          changed: observation.screenshot.changed,
          unchangedStreak: observation.screenshot.unchangedStreak,
          attached: screenshotAttached
        }
      : { attached: false },
    console: observation.console.slice(-10),
    failedRequests: observation.failedRequests.slice(-10),
    instruction: screenshotAttached
      ? 'Use the attached image only if semantic state is insufficient.'
      : 'No image was attached to this routine result. Call browser_observe with include_screenshot=true only when visual evidence is needed.'
  }
}

function compactAction(result: BrowserActionResult, screenshotAttached: boolean): unknown {
  return {
    sessionId: result.sessionId,
    tabId: result.tabId,
    action: result.action,
    targetMode: result.targetMode,
    coordinateFallbackUsed: result.coordinateFallbackUsed,
    durationMs: result.durationMs,
    quiescence: result.quiescence,
    loopProtection: result.loopProtection,
    ...(result.effect ? { effect: result.effect } : {}),
    observation: compactObservation(result.observation, screenshotAttached)
  }
}

function shouldAttachRoutineScreenshot(
  name: string,
  args: Record<string, unknown>,
  observation: BrowserObservation | undefined
): boolean {
  if (args.include_screenshot === true) return true
  if (args.include_screenshot === false) return false
  if (name === 'browser_observe') return true
  if (name === 'browser_navigate' || name === 'browser_resize') return true
  if (finiteNumber(args, 'x') !== undefined && finiteNumber(args, 'y') !== undefined) return true
  return (
    ['browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_hover'].includes(
      name
    ) && observation?.screenshotChanged === false
  )
}

function publicAction(result: BrowserActionResult): unknown {
  return { ...result, observation: publicObservation(result.observation) }
}

function screenshotMedia(
  artifact: BrowserScreenshotArtifact | undefined,
  description: string
): ToolResultMediaAttachment[] | undefined {
  if (!artifact) return undefined
  return [
    {
      type: 'image',
      mimeType: artifact.mimeType,
      name: `browser-${artifact.kind}-${artifact.id}.png`,
      description,
      source: { type: 'file', path: artifact.path }
    }
  ]
}

interface PreparedVisualAttachment {
  media?: ToolResultMediaAttachment[]
  metadata?: Record<string, unknown>
}

async function prepareVisualAttachment(
  service: NativeBrowserSessionService,
  artifact: BrowserScreenshotArtifact | undefined,
  signal: AbortSignal,
  description: string
): Promise<PreparedVisualAttachment> {
  if (!artifact) return {}
  if (artifact.bytes <= MAX_TOOL_RESULT_MEDIA_BYTES) {
    return { media: screenshotMedia(artifact, description) }
  }

  let fallback: BrowserScreenshotArtifact | undefined
  if (artifact.kind !== 'viewport') {
    fallback = await service
      .screenshot(
        { sessionId: artifact.sessionId, tabId: artifact.tabId, kind: 'viewport' },
        { signal }
      )
      .catch((error) => {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        return undefined
      })
  }
  const fallbackAttached = Boolean(fallback && fallback.bytes <= MAX_TOOL_RESULT_MEDIA_BYTES)
  return {
    ...(fallbackAttached
      ? { media: screenshotMedia(fallback, `${description} (viewport fallback)`) }
      : {}),
    metadata: {
      visualAttachment: 'omitted_too_large',
      visualAttachmentBytes: artifact.bytes,
      visualAttachmentLimitBytes: MAX_TOOL_RESULT_MEDIA_BYTES,
      ...(fallback
        ? {
            visualFallback: fallbackAttached ? 'viewport_attached' : 'viewport_too_large',
            visualFallbackBytes: fallback.bytes,
            visualFallbackScreenshot: withoutArtifactPath(fallback)
          }
        : {})
    }
  }
}

function addVisualMetadata(data: unknown, metadata: Record<string, unknown> | undefined): unknown {
  if (!metadata) return data
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, ...metadata }
  return { result: data, ...metadata }
}

function observationFromResult(value: unknown): BrowserObservation | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('observation' in value) {
    const observation = (value as { observation?: unknown }).observation
    return observation && typeof observation === 'object'
      ? (observation as BrowserObservation)
      : undefined
  }
  return 'tab' in value && 'viewport' in value ? (value as BrowserObservation) : undefined
}

function targetFromArguments(
  args: Record<string, unknown>,
  options: { required: boolean; coordinates?: boolean; preferredRoles?: string[] } = {
    required: true,
    coordinates: true
  }
): BrowserTarget | undefined {
  const ref = stringArgument(args, 'ref')
  const selector = stringArgument(args, 'selector')
  const text = stringArgument(args, 'text')
  const name = stringArgument(args, 'name') ?? text
  const role = stringArgument(args, 'role')
  const nth = finiteNumber(args, 'nth')
  const x = finiteNumber(args, 'x')
  const y = finiteNumber(args, 'y')
  const screenshotId = stringArgument(args, 'screenshot_id')
  if ((x === undefined) !== (y === undefined)) {
    throw new Error('Browser coordinates require both x and y')
  }
  if (x !== undefined && !options.coordinates) {
    throw new Error('This browser action does not accept coordinate targets')
  }
  if (x !== undefined && !screenshotId) {
    throw new Error('Browser coordinates require screenshot_id from the current viewport image')
  }
  const target = {
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
    ...(!ref && !selector && role ? { role } : {}),
    ...(!ref && !selector && name
      ? { name, exact: typeof args.exact === 'boolean' ? args.exact : false }
      : {}),
    ...(nth !== undefined ? { nth } : {}),
    ...(options.preferredRoles?.length ? { preferredRoles: options.preferredRoles } : {}),
    ...(screenshotId ? { screenshotId } : {}),
    ...(x !== undefined && y !== undefined ? { coordinates: { x, y } } : {})
  } as BrowserTarget
  if (!ref && !selector && !name && !role && x === undefined) {
    if (options.required)
      throw new Error('A browser element ref, selector, text, or coordinates is required')
    return undefined
  }
  return target
}

function formFieldsFromArguments(args: Record<string, unknown>): BrowserFormFieldInput[] {
  if (!Array.isArray(args.fields) || args.fields.length < 1) {
    throw new Error('browser_fill_form requires at least one field')
  }
  if (args.fields.length > 25) throw new Error('browser_fill_form supports at most 25 fields')
  return args.fields.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`browser_fill_form field ${index} must be an object`)
    }
    const field = raw as Record<string, unknown>
    const kind = stringArgument(field, 'kind')
    const target = targetFromArguments(field, { required: true, coordinates: false })!
    if (kind === 'textbox') {
      if (typeof field.value !== 'string') {
        throw new Error(`browser_fill_form textbox field ${index} requires a string value`)
      }
      return { kind, target, value: field.value }
    }
    if (kind === 'select') {
      const rawValues = Array.isArray(field.values) ? field.values : []
      const values = rawValues.filter((value): value is string => typeof value === 'string')
      if (!values.length || values.length !== rawValues.length || values.length > 20) {
        throw new Error(
          `browser_fill_form select field ${index} requires between one and 20 string values`
        )
      }
      return { kind, target, values }
    }
    if (kind === 'checkbox') {
      if (typeof field.checked !== 'boolean') {
        throw new Error(`browser_fill_form checkbox field ${index} requires checked`)
      }
      return { kind, target, checked: field.checked }
    }
    if (kind === 'radio') {
      if (field.checked !== true) {
        throw new Error(`browser_fill_form radio field ${index} requires checked=true`)
      }
      return { kind, target, checked: true }
    }
    throw new Error(`browser_fill_form field ${index} has an unsupported kind`)
  })
}

function publicFillForm(result: BrowserFillFormResult): unknown {
  return { ...result, observation: publicObservation(result.observation) }
}

function errorResult(
  title: string,
  error: unknown,
  context: AgentToolExecutionContext
): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (context.signal.aborted || name === 'AbortError') {
    return toolExecutionFailed({
      title,
      code: 'cancelled',
      status: 'cancelled',
      message: 'Browser operation cancelled',
      recoveryAction: 'stop'
    })
  }
  if (name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'timeout',
      message,
      retryable: true,
      recoveryAction: 'retry_later',
      recovery: 'Inspect the current browser state before deciding whether to retry.'
    })
  }
  if (name === 'BrowserLoopError' || /loop protection|identical action/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'loop_detected',
      message,
      recoveryAction: 'stop',
      recovery:
        'Observe the page and choose a different action instead of repeating the unchanged one.'
    })
  }
  if (isMissingSessionError(error)) {
    return toolExecutionFailed({
      title,
      code: 'not_found',
      message,
      recoveryAction: 'refresh_state',
      recovery: 'Open a browser session again with browser_open.'
    })
  }
  if (/stale; observe|ref is stale/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'conflict',
      message,
      retryable: true,
      recoveryAction: 'refresh_state',
      recovery: 'Call browser_observe and use a current semantic ref.'
    })
  }
  if (/not found|no longer available|not visible|ambiguous/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'not_found',
      message,
      retryable: true,
      recoveryAction: 'refresh_state',
      recovery: 'Observe the current page and choose an unambiguous semantic ref.'
    })
  }
  if (/file URL|file browsing|local browser file|escaped|project root/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'workspace_scope',
      message,
      recoveryAction: 'correct_input'
    })
  }
  if (/only HTTPS|plain HTTP|unsupported|protocol/i.test(message)) {
    return toolExecutionFailed({
      title,
      code: 'unsupported',
      message,
      recoveryAction: 'correct_input'
    })
  }
  if (
    /requires|must be|needs |invalid|outside|cannot contain|maximum|limit|absolute|coordinates|target|selector|key/i.test(
      message
    )
  ) {
    return toolExecutionFailed({
      title,
      code: 'invalid_arguments',
      message,
      recoveryAction: 'correct_input'
    })
  }
  return toolExecutionFailed({
    title,
    code: 'internal',
    message,
    retryable: true,
    recoveryAction: 'retry_later'
  })
}

/**
 * Owns browser sessions at conversation scope, independently of individual model runs.
 * Old inactive scopes are evicted FIFO/LRU-style before the native service reaches its
 * global limit; their durable screenshots are intentionally retained for chat history.
 */
export class AgentBrowserSessionManager {
  private readonly scopes = new Map<string, BrowserScopeEntry>()
  private readonly maxConversationSessions: number
  private readonly now: () => number
  private lockTail: Promise<void> = Promise.resolve()

  constructor(
    readonly service: NativeBrowserSessionService,
    options: AgentBrowserToolHandlerOptions = {}
  ) {
    this.maxConversationSessions = Math.max(
      1,
      Math.min(32, Math.trunc(options.maxConversationSessions ?? DEFAULT_MAX_CONVERSATION_SESSIONS))
    )
    this.now = options.now ?? Date.now
  }

  private async locked<T>(body: () => Promise<T> | T): Promise<T> {
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.lockTail.catch(() => undefined)
    this.lockTail = previous.then(() => turn)
    await previous
    try {
      return await body()
    } finally {
      release()
    }
  }

  async lease(scope: string, workspaceRoot?: string): Promise<BrowserSessionLease | undefined> {
    return this.locked(async () => {
      const entry = this.scopes.get(scope)
      if (!entry) return undefined
      const nextWorkspaceRootKey = workspaceRootKey(workspaceRoot)
      if (entry.workspaceRootKey !== nextWorkspaceRootKey) {
        if (entry.active > 0) {
          throw new Error('The conversation browser is still active in its previous project')
        }
        this.scopes.delete(scope)
        await this.service
          .close({ sessionId: entry.sessionId, deleteArtifacts: false })
          .catch((error) => {
            if (!isMissingSessionError(error)) throw error
          })
        return undefined
      }
      entry.active++
      entry.lastUsed = this.now()
      let released = false
      return {
        sessionId: entry.sessionId,
        entry,
        release: async () => {
          if (released) return
          released = true
          await this.locked(() => {
            entry.active = Math.max(0, entry.active - 1)
            entry.lastUsed = this.now()
          })
        }
      }
    })
  }

  async open(
    scope: string,
    runId: string,
    url: string,
    viewport: { width: number; height: number } | undefined,
    allowedFileRoots: string[],
    signal: AbortSignal
  ): Promise<{ observation: BrowserObservation; lease: BrowserSessionLease }> {
    return this.locked(async () => {
      const current = this.scopes.get(scope)
      if (current) {
        if (current.workspaceRootKey !== workspaceRootKey(allowedFileRoots[0])) {
          throw new Error('The conversation browser is still active in its previous project')
        }
        current.active++
        current.lastUsed = this.now()
        try {
          const observation = await this.service.navigate(
            { sessionId: current.sessionId, action: 'url', url },
            { signal }
          )
          return {
            observation: observation.observation,
            lease: this.leaseForLockedEntry(current)
          }
        } catch (error) {
          current.active = Math.max(0, current.active - 1)
          throw error
        }
      }
      while (this.scopes.size >= this.maxConversationSessions) {
        const evictable = [...this.scopes.entries()]
          .filter(([, entry]) => entry.active === 0)
          .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0]
        if (!evictable) {
          throw new Error('All browser conversation sessions are currently active')
        }
        this.scopes.delete(evictable[0])
        await this.service
          .close({ sessionId: evictable[1].sessionId, deleteArtifacts: false })
          .catch((error) => {
            if (!isMissingSessionError(error)) throw error
          })
      }
      const observation = await this.service.open(
        {
          runId,
          url,
          ...(viewport ? { viewport } : {}),
          ...(allowedFileRoots.length ? { allowedFileRoots } : {})
        },
        { signal }
      )
      const entry: BrowserScopeEntry = {
        sessionId: observation.sessionId,
        lastUsed: this.now(),
        active: 1,
        consoleCursor: 0,
        networkCursor: 0,
        workspaceRootKey: workspaceRootKey(allowedFileRoots[0])
      }
      this.scopes.set(scope, entry)
      return { observation, lease: this.leaseForLockedEntry(entry) }
    })
  }

  private leaseForLockedEntry(entry: BrowserScopeEntry): BrowserSessionLease {
    let released = false
    return {
      sessionId: entry.sessionId,
      entry,
      release: async () => {
        if (released) return
        released = true
        await this.locked(() => {
          entry.active = Math.max(0, entry.active - 1)
          entry.lastUsed = this.now()
        })
      }
    }
  }

  async forgetIfStale(scope: string, sessionId: string, error: unknown): Promise<void> {
    if (!isMissingSessionError(error)) return
    await this.locked(() => {
      if (this.scopes.get(scope)?.sessionId === sessionId) this.scopes.delete(scope)
    })
  }

  async closeScope(scope: string): Promise<{ closedSessions: string[]; closedTabs: string[] }> {
    const entry = await this.locked(() => {
      const value = this.scopes.get(scope)
      this.scopes.delete(scope)
      return value
    })
    if (!entry) return { closedSessions: [], closedTabs: [] }
    try {
      return await this.service.close({ sessionId: entry.sessionId, deleteArtifacts: false })
    } catch (error) {
      if (isMissingSessionError(error)) return { closedSessions: [], closedTabs: [] }
      throw error
    }
  }

  async forgetScopeIfEmpty(scope: string, tabs: readonly unknown[]): Promise<void> {
    if (tabs.length) return
    await this.locked(() => {
      this.scopes.delete(scope)
    })
  }

  async dispose(): Promise<void> {
    await this.locked(() => this.scopes.clear())
    await this.service.dispose()
  }
}

async function boundedSuccess(
  outputs: ToolOutputStore,
  title: string,
  data: unknown,
  modelData: unknown,
  media?: ToolResultMediaAttachment[]
): Promise<ToolExecutionResult> {
  const bounded = await outputs.apply(JSON.stringify(modelData), {
    maxBytes: 40 * 1024,
    maxLines: 600,
    maxTokens: 6_000,
    preview: 'head-tail'
  })
  return toolExecutionSucceeded({
    title,
    data,
    modelContent: bounded.content,
    output: bounded.output,
    media
  })
}

async function boundedInspectionSuccess(
  outputs: ToolOutputStore,
  title: string,
  data: unknown
): Promise<ToolExecutionResult> {
  const bounded = await outputs.apply(JSON.stringify(data), {
    maxBytes: 12 * 1024,
    maxLines: 160,
    maxTokens: 2_000,
    preview: 'head'
  })
  return toolExecutionSucceeded({
    title,
    data,
    modelContent: bounded.content,
    output: bounded.output
  })
}

async function boundedVisualSuccess(
  outputs: ToolOutputStore,
  manager: AgentBrowserSessionManager,
  title: string,
  data: unknown,
  modelData: unknown,
  artifact: BrowserScreenshotArtifact | undefined,
  signal: AbortSignal,
  description: string
): Promise<ToolExecutionResult> {
  const visual = await prepareVisualAttachment(manager.service, artifact, signal, description)
  return boundedSuccess(
    outputs,
    title,
    addVisualMetadata(data, visual.metadata),
    addVisualMetadata(modelData, visual.metadata),
    visual.media
  )
}

async function boundedVisualFormFailure(
  outputs: ToolOutputStore,
  manager: AgentBrowserSessionManager,
  title: string,
  result: BrowserFillFormResult,
  signal: AbortSignal
): Promise<ToolExecutionResult> {
  const firstFailure = result.fields.find((field) => field.status === 'failed')
  const unsupported = firstFailure?.error?.code === 'unsupported_control'
  const recovery = unsupported
    ? 'Use a dedicated browser action for this custom control, then resume the remaining fields.'
    : 'Use the returned final observation to retarget only the failed and skipped fields.'
  const data = {
    ...(publicFillForm(result) as Record<string, unknown>),
    recovery: {
      action: unsupported ? 'change_strategy' : 'refresh_state',
      instruction: recovery
    }
  }
  const visual = await prepareVisualAttachment(
    manager.service,
    result.observation.screenshot,
    signal,
    'Browser form state after the batch stopped'
  )
  const modelData = addVisualMetadata(data, visual.metadata)
  const bounded = await outputs.apply(JSON.stringify(modelData), {
    maxBytes: 40 * 1024,
    maxLines: 600,
    maxTokens: 6_000,
    preview: 'head-tail'
  })
  return toolExecutionFailed({
    title,
    code: unsupported ? 'unsupported' : 'conflict',
    message:
      firstFailure?.error?.message ??
      'The form batch stopped because the page changed before completion.',
    retryable: !unsupported,
    recoveryAction: unsupported ? 'change_strategy' : 'refresh_state',
    recovery,
    data: addVisualMetadata(data, visual.metadata),
    modelContent: bounded.content,
    output: bounded.output,
    media: visual.media
  })
}

export function registerBrowserToolHandlers(
  registry: AgentToolHandlerRegistry,
  manager: AgentBrowserSessionManager,
  outputs: ToolOutputStore
): void {
  registry.register(AGENT_BROWSER_TOOL_NAMES, async ({ name, title, arguments: args, context }) => {
    const scope = browserScope(context)
    if (name === 'browser_close') {
      try {
        const result = await manager.closeScope(scope)
        return boundedSuccess(outputs, title, result, result)
      } catch (error) {
        return errorResult(title, error, context)
      }
    }

    let lease: BrowserSessionLease | undefined
    try {
      const requestedNavigateAction =
        name === 'browser_navigate' ? stringArgument(args, 'action') : undefined
      const requestedNavigateUrl =
        name === 'browser_navigate' ? stringArgument(args, 'url') : undefined
      if (name === 'browser_navigate') {
        if (!requestedNavigateAction) throw new Error('browser_navigate requires an action')
        if (!['url', 'back', 'forward', 'reload'].includes(requestedNavigateAction)) {
          throw new Error('browser_navigate action must be url, back, forward, or reload')
        }
        if (requestedNavigateAction === 'url' && !requestedNavigateUrl) {
          throw new Error('browser_navigate action url requires a URL')
        }
        if (requestedNavigateAction !== 'url' && requestedNavigateUrl) {
          throw new Error(`browser_navigate action ${requestedNavigateAction} does not accept a URL`)
        }
      }
      lease = await manager.lease(scope, context.workspaceRoot)
      if (name === 'browser_open') {
        const url = stringArgument(args, 'url')
        if (!url) throw new Error('browser_open requires an absolute URL')
        if (!lease) {
          const width = finiteNumber(args, 'width')
          const height = finiteNumber(args, 'height')
          const opened = await manager.open(
            scope,
            context.runId,
            url,
            width !== undefined || height !== undefined
              ? { width: width ?? 1280, height: height ?? 800 }
              : undefined,
            context.workspaceRoot ? [context.workspaceRoot] : [],
            context.signal
          )
          lease = opened.lease
          const data = publicObservation(opened.observation)
          return boundedVisualSuccess(
            outputs,
            manager,
            title,
            data,
            data,
            opened.observation.screenshot,
            context.signal,
            'Browser page opened for visual inspection'
          )
        }
        const value =
          args.new_tab === true
            ? await manager.service.tabs(
                { sessionId: lease.sessionId, action: 'new', url },
                { signal: context.signal }
              )
            : await manager.service.navigate(
                { sessionId: lease.sessionId, url },
                { signal: context.signal }
              )
        const observation = observationFromResult(value)
        const data = observation
          ? 'action' in (value as object)
            ? publicAction(value as BrowserActionResult)
            : { ...(value as object), observation: publicObservation(observation) }
          : value
        return boundedVisualSuccess(
          outputs,
          manager,
          title,
          data,
          data,
          observation?.screenshot,
          context.signal,
          'Browser page opened for visual inspection'
        )
      }

      if (!lease) {
        if (
          name === 'browser_navigate' &&
          requestedNavigateAction === 'url' &&
          requestedNavigateUrl
        ) {
          const opened = await manager.open(
            scope,
            context.runId,
            requestedNavigateUrl,
            undefined,
            context.workspaceRoot ? [context.workspaceRoot] : [],
            context.signal
          )
          lease = opened.lease
          const data = publicObservation(opened.observation)
          return boundedVisualSuccess(
            outputs,
            manager,
            title,
            data,
            data,
            opened.observation.screenshot,
            context.signal,
            'Browser page opened for visual inspection'
          )
        }
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: 'No browser session exists for this conversation',
          recoveryAction: 'refresh_state',
          recovery: 'Call browser_open with the page URL first.'
        })
      }

      let raw: unknown
      const mediaDescription = 'Current browser state for visual inspection'
      if (name === 'browser_observe') {
        raw = await manager.service.observe(
          lease.sessionId,
          {
            screenshot:
              args.include_screenshot === false
                ? 'none'
                : args.full_page === true
                  ? 'fullPage'
                  : 'viewport',
            includeSemanticSnapshot: args.include_accessibility !== false
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_screenshot') {
        const target = targetFromArguments(args, { required: false, coordinates: false })
        const artifact = await manager.service.screenshot(
          {
            sessionId: lease.sessionId,
            kind: target ? 'element' : args.full_page === true ? 'fullPage' : 'viewport',
            ...(target ? { target } : {})
          },
          { signal: context.signal }
        )
        const data = { screenshot: withoutArtifactPath(artifact) }
        return boundedVisualSuccess(
          outputs,
          manager,
          title,
          data,
          data,
          artifact,
          context.signal,
          stringArgument(args, 'description') || 'Browser screenshot for visual inspection'
        )
      } else if (name === 'browser_click') {
        raw = await manager.service.click(
          {
            sessionId: lease.sessionId,
            target: targetFromArguments(args, {
              required: true,
              coordinates: true,
              preferredRoles: [
                'button',
                'link',
                'checkbox',
                'radio',
                'menuitem',
                'tab',
                'switch'
              ]
            })!,
            button: (stringArgument(args, 'button') as 'left' | 'middle' | 'right') ?? 'left',
            clickCount: (finiteNumber(args, 'click_count') as 1 | 2 | 3 | undefined) ?? 1
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_type') {
        raw = await manager.service.type(
          {
            sessionId: lease.sessionId,
            target: targetFromArguments(args, {
              required: true,
              coordinates: false,
              preferredRoles: ['textbox', 'searchbox', 'combobox', 'spinbutton']
            })!,
            text: typeof args.value === 'string' ? args.value : '',
            clear: args.clear !== false,
            submit: args.submit === true
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_select') {
        const values = Array.isArray(args.values)
          ? args.values.filter((value): value is string => typeof value === 'string')
          : []
        if (!values.length) throw new Error('browser_select requires at least one string value')
        raw = await manager.service.select(
          {
            sessionId: lease.sessionId,
            target: targetFromArguments(args, {
              required: true,
              coordinates: false,
              preferredRoles: ['combobox', 'listbox']
            })!,
            values
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_fill_form') {
        const result = await manager.service.fillForm(
          { sessionId: lease.sessionId, fields: formFieldsFromArguments(args) },
          { signal: context.signal }
        )
        if (!result.completed) {
          return boundedVisualFormFailure(outputs, manager, title, result, context.signal)
        }
        raw = result
      } else if (name === 'browser_press') {
        raw = await manager.service.press(
          { sessionId: lease.sessionId, key: stringArgument(args, 'key') || '' },
          { signal: context.signal }
        )
      } else if (name === 'browser_scroll') {
        raw = await manager.service.scroll(
          {
            sessionId: lease.sessionId,
            target: targetFromArguments(args, { required: false, coordinates: false }),
            deltaX: finiteNumber(args, 'delta_x'),
            deltaY: finiteNumber(args, 'delta_y') ?? 600
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_hover') {
        raw = await manager.service.hover(
          { sessionId: lease.sessionId, target: targetFromArguments(args)! },
          { signal: context.signal }
        )
      } else if (name === 'browser_wait') {
        let condition: BrowserWaitCondition = { type: 'quiescence' }
        const selector = stringArgument(args, 'selector')
        const text = stringArgument(args, 'text')
        const url = stringArgument(args, 'url_contains')
        const milliseconds = finiteNumber(args, 'milliseconds')
        if (selector) condition = { type: 'semantic', target: { selector } as BrowserTarget }
        else if (text) condition = { type: 'text', text }
        else if (url) condition = { type: 'url', value: url, match: 'contains' }
        else if (milliseconds !== undefined) condition = { type: 'time', ms: milliseconds }
        raw = await manager.service.wait(
          { sessionId: lease.sessionId, condition },
          { signal: context.signal }
        )
      } else if (name === 'browser_navigate') {
        raw = await manager.service.navigate(
          {
            sessionId: lease.sessionId,
            ...(requestedNavigateAction === 'url'
              ? { url: requestedNavigateUrl! }
              : { action: requestedNavigateAction! })
          } as BrowserNavigateInput,
          { signal: context.signal }
        )
      } else if (name === 'browser_resize') {
        const width = finiteNumber(args, 'width')
        const height = finiteNumber(args, 'height')
        const deviceScaleFactor = finiteNumber(args, 'device_scale_factor')
        if (width === undefined || height === undefined) {
          throw new Error('browser_resize requires finite width and height')
        }
        raw = await manager.service.resize(
          {
            sessionId: lease.sessionId,
            viewport: {
              width,
              height,
              ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor })
            }
          },
          { signal: context.signal }
        )
      } else if (name === 'browser_tabs') {
        const action = stringArgument(args, 'action') as 'list' | 'new' | 'select' | 'close'
        if (!action) throw new Error('browser_tabs requires an action')
        const result = await manager.service.tabs(
          {
            sessionId: lease.sessionId,
            action,
            tabId: stringArgument(args, 'tab_id'),
            url: stringArgument(args, 'url')
          },
          { signal: context.signal }
        )
        await manager.forgetScopeIfEmpty(scope, result.tabs)
        const observation = result.observation
        const data = {
          ...result,
          ...(observation ? { observation: publicObservation(observation) } : {})
        }
        return boundedVisualSuccess(
          outputs,
          manager,
          title,
          data,
          data,
          observation?.screenshot,
          context.signal,
          'Selected browser tab for visual inspection'
        )
      } else if (name === 'browser_console') {
        const result = await manager.service.console(
          { sessionId: lease.sessionId, afterSequence: lease.entry.consoleCursor },
          { signal: context.signal }
        )
        let entries = result.entries
        const level = stringArgument(args, 'level')
        if (level && level !== 'all') {
          const normalized = level === 'information' ? 'info' : level
          entries = entries.filter((entry) => entry.level === normalized)
        }
        if (args.clear === true) lease.entry.consoleCursor = result.cursor
        const data = {
          entries: entries.slice(-MAX_PERSISTED_TELEMETRY),
          cursor: result.cursor,
          clearedThrough: lease.entry.consoleCursor
        }
        return boundedInspectionSuccess(outputs, title, data)
      } else if (name === 'browser_network') {
        const result = await manager.service.network(
          { sessionId: lease.sessionId, afterSequence: lease.entry.networkCursor },
          { signal: context.signal }
        )
        if (args.clear === true) lease.entry.networkCursor = result.cursor
        const data = {
          failures: result.failures.slice(-MAX_PERSISTED_TELEMETRY),
          cursor: result.cursor,
          clearedThrough: lease.entry.networkCursor,
          capturedFailuresOnly: true
        }
        return boundedInspectionSuccess(outputs, title, data)
      } else if (name === 'browser_evaluate') {
        const expression = typeof args.expression === 'string' ? args.expression : ''
        assertBrowserEvaluationIsInspectionOnly(expression)
        const evaluation = await manager.service.evaluate(
          {
            sessionId: lease.sessionId,
            expression
          },
          { signal: context.signal }
        )
        const data = {
          value: evaluation.value,
          serializedBytes: evaluation.serializedBytes,
          truncated: evaluation.truncated
        }
        return boundedInspectionSuccess(outputs, title, data)
      } else if (name === 'browser_verify') {
        const criterion = stringArgument(args, 'criterion')
        if (!criterion) throw new Error('browser_verify requires a visual criterion')
        const observation = await manager.service.observe(
          lease.sessionId,
          {
            screenshot: args.full_page === true ? 'fullPage' : 'viewport',
            includeSemanticSnapshot: true
          },
          { signal: context.signal }
        )
        const data = {
          criterion,
          status: 'evidence_captured',
          passed: null,
          requiresModelJudgement: true,
          verification: {
            status: 'evidence',
            summary: criterion,
            passed: null,
            requiresModelJudgement: true
          },
          instruction:
            'Inspect the attached screenshot before deciding whether this criterion passes.',
          observation: publicObservation(observation)
        }
        return boundedVisualSuccess(
          outputs,
          manager,
          title,
          data,
          data,
          observation.screenshot,
          context.signal,
          `Visual verification evidence: ${criterion}`
        )
      } else {
        throw new Error(`Unsupported browser tool: ${name}`)
      }

      const observation = observationFromResult(raw)
      const semanticLimit = finiteNumber(args, 'max_elements')
      const data = observation
        ? raw && typeof raw === 'object' && 'observation' in raw
          ? { ...(raw as object), observation: publicObservation(observation, semanticLimit) }
          : publicObservation(observation, semanticLimit)
        : raw
      const attachScreenshot = shouldAttachRoutineScreenshot(name, args, observation)
      const modelData = observation
        ? raw && typeof raw === 'object' && 'observation' in raw
          ? compactAction(raw as BrowserActionResult, attachScreenshot)
          : compactObservation(observation, attachScreenshot, semanticLimit)
        : raw
      return boundedVisualSuccess(
        outputs,
        manager,
        title,
        data,
        modelData,
        attachScreenshot ? observation?.screenshot : undefined,
        context.signal,
        mediaDescription
      )
    } catch (error) {
      if (lease) await manager.forgetIfStale(scope, lease.sessionId, error)
      return errorResult(title, error, context)
    } finally {
      await lease?.release()
    }
  })
}
