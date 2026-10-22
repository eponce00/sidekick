/**
 * The tools a page offers SideKick's agent through WebMCP
 * (https://webmachinelearning.github.io/webmcp/), kept per browser tab from the events of
 * Chromium's own implementation, read over its DevTools `WebMCP` domain. Only the tab's top-level
 * document counts: its origin is the one in the address bar. Everything a tool carries — name,
 * description, schema and result — is the page's content and is bounded here before anyone reads it.
 */

export const WEBMCP_MAX_TOOLS = 50
export const WEBMCP_MAX_DESCRIPTION_CHARS = 2_000
export const WEBMCP_MAX_SCHEMA_BYTES = 16 * 1024
export const WEBMCP_MAX_RESULT_BYTES = 256 * 1024
export const WEBMCP_MAX_ERROR_CHARS = 2_000
export const WEBMCP_CALL_TIMEOUT_MS = 30_000
/** How long a script tool's call waits for an answer after the page navigates; Chromium sends none. */
const SCRIPT_NAVIGATION_GRACE_MS = 1_000
/** Answers kept for invocations not yet awaited: the answer can arrive before invokeTool returns. */
const MAX_EARLY_RESPONSES = 20

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * Chromium 150 (Electron 43) predates two parts of the specification that pages written today rely
 * on: `registerTool` returns a promise, and `execute` receives `{signal}`, aborted when the call
 * is cancelled. This script, added before any page script runs, supplies both and defers to the
 * native behavior wherever Chromium already has it.
 */
export const WEBMCP_COMPATIBILITY_SCRIPT = String.raw`(() => {
  const prototype = globalThis.ModelContext && globalThis.ModelContext.prototype;
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'registerTool');
  const native = descriptor && descriptor.value;
  if (typeof native !== 'function') return;
  const running = new Map();
  addEventListener('toolcancel', (event) => {
    for (const controller of running.get(event.toolName) || []) {
      controller.abort(new DOMException('The tool call was cancelled.', 'AbortError'));
    }
  });
  const withSignal = (tool) => {
    if (!tool || typeof tool !== 'object' || typeof tool.execute !== 'function') return tool;
    const execute = tool.execute;
    const name = String(tool.name);
    const definition = {};
    for (const key of ['annotations', 'description', 'inputSchema', 'name', 'title']) {
      if (tool[key] !== undefined) definition[key] = tool[key];
    }
    definition.execute = function (input, options) {
      if (options && options.signal) return execute.call(this, input, options);
      const controller = new AbortController();
      let calls = running.get(name);
      if (!calls) running.set(name, (calls = new Set()));
      calls.add(controller);
      const done = () => {
        calls.delete(controller);
        if (!calls.size && running.get(name) === calls) running.delete(name);
      };
      try {
        return Promise.resolve(execute.call(this, input, { signal: controller.signal })).finally(done);
      } catch (error) {
        done();
        throw error;
      }
    };
    return definition;
  };
  Object.defineProperty(prototype, 'registerTool', {
    ...descriptor,
    value: function registerTool(tool) {
      try {
        const result = native.call(this, withSignal(tool), ...Array.prototype.slice.call(arguments, 1));
        return result && typeof result.then === 'function' ? result : Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  });
})()`

export interface WebMcpTool {
  name: string
  description: string
  /** The page's JSON Schema for the input; null when it gave none or one too large to keep. */
  inputSchema: Record<string, unknown> | null
  /** The page gave a schema larger than SideKick keeps, so input is not checked against it. */
  schemaOmitted?: boolean
  descriptionTruncated?: boolean
  /** The site's claim that the tool changes nothing. Never true for a form. */
  readOnly: boolean
  /** The site says the result holds content it did not write, such as reviews. */
  untrustedContent: boolean
  /** A declarative `<form toolname>`: calling it fills the form, and submits it if `autosubmit`. */
  form: boolean
  autosubmit: boolean
  /** Changes whenever the page registers this name again. */
  version: number
}

export interface WebMcpPageListing {
  available: boolean
  origin: string
  url: string
  /** Counts the documents the tab has loaded; a new one has none of the old one's tools. */
  document: number
  tools: WebMcpTool[]
  /** Tools the page registered beyond what SideKick keeps. */
  omitted: number
}

export type WebMcpCallErrorCode =
  | 'unavailable'
  | 'cross_origin'
  | 'not_listed'
  | 'navigated'
  | 'changed'
  | 'not_found'
  | 'invalid_arguments'

/** Why a call to a page's tool is refused before it runs. */
export class WebMcpCallError extends Error {
  constructor(
    readonly code: WebMcpCallErrorCode,
    message: string,
    readonly recovery: string
  ) {
    super(message)
    this.name = 'WebMcpCallError'
  }
}

export type WebMcpCallOutcome =
  | {
      status: 'completed'
      output: unknown
      truncated: boolean
      bytes: number
      /** Where the page went while the tool ran, as a form's submission does. */
      navigatedTo?: string
    }
  | { status: 'error'; message: string; exceptionObjectId?: string }
  | { status: 'cancelled' }
  | { status: 'timeout' }
  /** The page loaded another document and the tool never answered. */
  | { status: 'navigated'; url: string }

interface PendingCall {
  form: boolean
  navigatedTo?: string
  settle: (outcome: WebMcpCallOutcome) => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit
    ? { text: `${text.slice(0, limit)}…`, truncated: true }
    : { text, truncated: false }
}

/** The origin SideKick shows and binds calls to: Chromium's, or the URL's when it gave none. */
export function documentOrigin(frame: Record<string, unknown>): string {
  if (typeof frame.securityOrigin === 'string' && frame.securityOrigin) return frame.securityOrigin
  try {
    return new URL(String(frame.url ?? '')).origin
  } catch {
    return 'null'
  }
}

/** A tool as Chromium reported it, bounded, before it is given a version; null when it cannot be one. */
export function webMcpToolFromProtocol(value: unknown): WebMcpTool | null {
  const raw = record(value)
  if (!raw || typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) return null
  if (typeof raw.description !== 'string' || !raw.description.trim()) return null
  const description = bounded(raw.description, WEBMCP_MAX_DESCRIPTION_CHARS)
  const schema = record(raw.inputSchema)
  let inputSchema: Record<string, unknown> | null = null
  let schemaOmitted = false
  if (schema) {
    let size = Infinity
    try {
      size = Buffer.byteLength(JSON.stringify(schema), 'utf8')
    } catch {
      // A schema Chromium sent always serializes; anything else is dropped.
    }
    if (size <= WEBMCP_MAX_SCHEMA_BYTES) inputSchema = schema
    else schemaOmitted = true
  }
  const annotations = record(raw.annotations) ?? {}
  const form = typeof raw.backendNodeId === 'number'
  return {
    name: raw.name,
    description: description.text,
    inputSchema,
    ...(schemaOmitted ? { schemaOmitted } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    readOnly: annotations.readOnly === true && !form,
    untrustedContent: annotations.untrustedContent === true,
    form,
    autosubmit: annotations.autosubmit === true,
    version: 0
  }
}

/** The result of a call, bounded to WEBMCP_MAX_RESULT_BYTES of JSON. */
export function webMcpOutcomeFromResponse(params: Record<string, unknown>): WebMcpCallOutcome {
  const status = String(params.status ?? '')
  if (status === 'Canceled') return { status: 'cancelled' }
  if (status !== 'Completed') {
    const exception = record(params.exception)
    const message =
      (typeof params.errorText === 'string' && params.errorText) ||
      (typeof exception?.description === 'string' && exception.description) ||
      'The tool reported an error without a message.'
    return {
      status: 'error',
      message: bounded(message, WEBMCP_MAX_ERROR_CHARS).text,
      ...(typeof exception?.objectId === 'string' ? { exceptionObjectId: exception.objectId } : {})
    }
  }
  const output = params.output === undefined ? null : params.output
  let json: string
  try {
    json = JSON.stringify(output) ?? 'null'
  } catch {
    json = 'null'
  }
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes <= WEBMCP_MAX_RESULT_BYTES)
    return { status: 'completed', output, truncated: false, bytes }
  // Cut on a character boundary; the cut text stands in for the value.
  const cut = Buffer.from(json, 'utf8')
    .subarray(0, WEBMCP_MAX_RESULT_BYTES)
    .toString('utf8')
    .replace(/�$/, '')
  return { status: 'completed', output: cut, truncated: true, bytes }
}

/** One tab's WebMCP state, fed with its DevTools protocol events. */
export class WebMcpPageTools {
  available = false
  private mainFrameId?: string
  private origin = 'null'
  private url = ''
  private document = 0
  private versions = 0
  private omitted = 0
  private readonly tools = new Map<string, WebMcpTool>()
  private listing?: { document: number; origin: string; versions: Map<string, number> }
  private readonly pending = new Map<string, PendingCall>()
  private readonly early = new Map<string, Record<string, unknown>>()

  /** Starts from the frame the tab shows when WebMCP is enabled on it. */
  attach(frame: Record<string, unknown>): void {
    if (typeof frame.id === 'string') this.mainFrameId = frame.id
    this.origin = documentOrigin(frame)
    this.url = String(frame.url ?? '')
  }

  handle(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.frameNavigated') {
      const frame = record(params.frame)
      if (!frame || frame.parentId) return
      if (typeof frame.id === 'string') this.mainFrameId = frame.id
      // A new document has a new, empty ModelContext; nothing announces the old tools leaving.
      this.document++
      this.origin = documentOrigin(frame)
      this.url = String(frame.url ?? '')
      this.tools.clear()
      this.omitted = 0
      for (const call of this.pending.values()) call.navigatedTo ??= this.url
      for (const [id, call] of this.pending) {
        if (!call.form)
          setTimeout(
            () => this.finish(id, { status: 'navigated', url: this.url }),
            SCRIPT_NAVIGATION_GRACE_MS
          )
      }
      return
    }
    if (method === 'Page.navigatedWithinDocument') {
      if (params.frameId === this.mainFrameId && typeof params.url === 'string')
        this.url = params.url
      return
    }
    if (method === 'WebMCP.toolsAdded') {
      if (!this.mainFrameId) return
      for (const raw of Array.isArray(params.tools) ? params.tools : []) {
        if (record(raw)?.frameId !== this.mainFrameId) continue
        const tool = webMcpToolFromProtocol(raw)
        if (!tool) continue
        if (!this.tools.has(tool.name) && this.tools.size >= WEBMCP_MAX_TOOLS) {
          this.omitted++
          continue
        }
        this.tools.set(tool.name, { ...tool, version: ++this.versions })
      }
      return
    }
    if (method === 'WebMCP.toolsRemoved') {
      for (const raw of Array.isArray(params.tools) ? params.tools : []) {
        const removed = record(raw)
        if (removed && removed.frameId === this.mainFrameId && typeof removed.name === 'string') {
          this.tools.delete(removed.name)
        }
      }
      return
    }
    if (method === 'WebMCP.toolResponded') {
      const id = String(params.invocationId ?? '')
      if (!id) return
      if (this.pending.has(id)) {
        this.finish(id, webMcpOutcomeFromResponse(params))
        return
      }
      this.early.set(id, params)
      while (this.early.size > MAX_EARLY_RESPONSES)
        this.early.delete(this.early.keys().next().value!)
    }
  }

  /** The current document's tools, without marking them listed. */
  snapshot(): WebMcpPageListing {
    return {
      available: this.available,
      origin: this.origin,
      url: this.url,
      document: this.document,
      tools: [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name)),
      omitted: this.omitted
    }
  }

  /** The current document's tools, binding the calls that follow to them. */
  list(): WebMcpPageListing {
    const snapshot = this.snapshot()
    this.listing = {
      document: snapshot.document,
      origin: snapshot.origin,
      versions: new Map(snapshot.tools.map((tool) => [tool.name, tool.version]))
    }
    return snapshot
  }

  /** The listed tool a call may run, or why it is refused. */
  callable(origin: string, name: string): { tool: WebMcpTool; frameId: string; document: number } {
    if (!this.available || !this.mainFrameId) {
      throw new WebMcpCallError(
        'unavailable',
        'This browser tab cannot offer WebMCP tools.',
        'Use the page with the ordinary browser tools instead.'
      )
    }
    if (origin !== this.origin) {
      throw new WebMcpCallError(
        'cross_origin',
        `The page in this tab is ${this.origin}, not ${origin}; a site's tools can only be called on that site.`,
        'List the tools of the page that is open now with browser_list_webmcp_tools, or open the site the tool belongs to first.'
      )
    }
    const listing = this.listing
    if (!listing || listing.origin !== this.origin) {
      throw new WebMcpCallError(
        'not_listed',
        `The tools of ${this.origin} have not been listed for this page.`,
        'Call browser_list_webmcp_tools first, then call a tool it returned.'
      )
    }
    if (listing.document !== this.document) {
      throw new WebMcpCallError(
        'navigated',
        `The page loaded a new document since its tools were listed, so ${name} may no longer be the tool that was listed.`,
        'Call browser_list_webmcp_tools again and use what the page offers now.'
      )
    }
    const tool = this.tools.get(name)
    const listedVersion = listing.versions.get(name)
    if (!tool || listedVersion === undefined) {
      throw new WebMcpCallError(
        'not_found',
        listedVersion === undefined
          ? `${this.origin} did not offer a tool named ${name} when its tools were listed.`
          : `${this.origin} no longer offers ${name}.`,
        'Call browser_list_webmcp_tools again and choose one of the tools it returns.'
      )
    }
    if (tool.version !== listedVersion) {
      throw new WebMcpCallError(
        'changed',
        `${this.origin} registered ${name} again since its tools were listed.`,
        'Call browser_list_webmcp_tools again to read the tool as the page offers it now.'
      )
    }
    return { tool, frameId: this.mainFrameId, document: this.document }
  }

  /** Waits for an invocation's answer, a navigation the page never answers after, or `timeoutMs`. */
  awaitResult(
    invocationId: string,
    options: { form: boolean; timeoutMs: number; signal: AbortSignal }
  ): Promise<WebMcpCallOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.finish(invocationId, { status: 'timeout' }),
        options.timeoutMs
      )
      const abort = (): void => this.finish(invocationId, { status: 'cancelled' })
      this.pending.set(invocationId, {
        form: options.form,
        settle: (outcome) => {
          clearTimeout(timer)
          options.signal.removeEventListener('abort', abort)
          const navigatedTo = this.pending.get(invocationId)?.navigatedTo
          this.pending.delete(invocationId)
          // A form's answer comes from the page its submission loaded. A call that timed out or
          // failed after the page moved on failed because it did.
          if (navigatedTo && outcome.status === 'completed') resolve({ ...outcome, navigatedTo })
          else if (navigatedTo && (outcome.status === 'timeout' || outcome.status === 'error'))
            resolve({ status: 'navigated', url: navigatedTo })
          else resolve(outcome)
        }
      })
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      const answered = this.early.get(invocationId)
      if (answered) {
        this.early.delete(invocationId)
        this.finish(invocationId, webMcpOutcomeFromResponse(answered))
      }
    })
  }

  /** Ends every call still waiting, as when the tab closes. */
  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { status: 'cancelled' })
    this.early.clear()
  }

  private finish(invocationId: string, outcome: WebMcpCallOutcome): void {
    this.pending.get(invocationId)?.settle(outcome)
  }
}
