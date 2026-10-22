import { runInNewContext } from 'vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEBMCP_COMPATIBILITY_SCRIPT,
  WEBMCP_MAX_DESCRIPTION_CHARS,
  WEBMCP_MAX_RESULT_BYTES,
  WEBMCP_MAX_TOOLS,
  WebMcpCallError,
  WebMcpPageTools,
  webMcpOutcomeFromResponse,
  webMcpToolFromProtocol,
  type WebMcpCallOutcome
} from './webMcpPageTools'

const ORIGIN = 'https://shop.example'

function tool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
    frameId: 'main',
    ...extra
  }
}

function navigate(page: WebMcpPageTools, url: string, frame: Record<string, unknown> = {}): void {
  page.handle('Page.frameNavigated', {
    frame: { id: 'main', url, securityOrigin: new URL(url).origin, ...frame }
  })
}

function pageWith(...tools: Record<string, unknown>[]): WebMcpPageTools {
  const page = new WebMcpPageTools()
  page.attach({ id: 'main', url: 'about:blank', securityOrigin: '://' })
  page.available = true
  navigate(page, `${ORIGIN}/cart`)
  page.handle('WebMCP.toolsAdded', { tools })
  return page
}

function refusal(action: () => unknown): WebMcpCallError {
  try {
    action()
  } catch (error) {
    if (error instanceof WebMcpCallError) return error
    throw error
  }
  throw new Error('The call was not refused')
}

describe('webMcpToolFromProtocol', () => {
  it('keeps a tool as Chromium reports it, with the annotations SideKick acts on', () => {
    expect(
      webMcpToolFromProtocol(
        tool('get_cart', { annotations: { readOnly: true, untrustedContent: true } })
      )
    ).toEqual({
      name: 'get_cart',
      description: 'get_cart description',
      inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
      readOnly: true,
      untrustedContent: true,
      consequential: false,
      form: false,
      autosubmit: false,
      version: 0
    })
  })

  it("reads the protocol's consequential mark, and never offers a tool marked for debugging", () => {
    expect(
      webMcpToolFromProtocol(tool('buy', { annotations: { consequential: true, readOnly: true } }))
    ).toMatchObject({ consequential: true })
    expect(
      webMcpToolFromProtocol(tool('dump_state', { annotations: { debugging: true } }))
    ).toBeNull()
    const page = pageWith(
      tool('dump_state', { annotations: { debugging: true } }),
      tool('add_item')
    )
    expect(page.snapshot().tools.map(({ name }) => name)).toEqual(['add_item'])
  })

  it('refuses names and descriptions the specification does not allow', () => {
    expect(webMcpToolFromProtocol(tool('has space'))).toBeNull()
    expect(webMcpToolFromProtocol(tool('n'.repeat(129)))).toBeNull()
    expect(webMcpToolFromProtocol(tool('café'))).toBeNull()
    expect(webMcpToolFromProtocol(tool('ok', { description: '   ' }))).toBeNull()
    expect(webMcpToolFromProtocol('not a tool')).toBeNull()
  })

  it('bounds a description and drops a schema too large to keep', () => {
    const bounded = webMcpToolFromProtocol(
      tool('huge', {
        description: 'd'.repeat(200_000),
        inputSchema: { type: 'object', description: 'x'.repeat(20_000) }
      })
    )!
    expect(bounded.description.length).toBe(WEBMCP_MAX_DESCRIPTION_CHARS + 1)
    expect(bounded.descriptionTruncated).toBe(true)
    expect(bounded.inputSchema).toBeNull()
    expect(bounded.schemaOmitted).toBe(true)
  })

  it('never treats a form as read-only, whatever the page claims', () => {
    const form = webMcpToolFromProtocol(
      tool('search_flights', {
        backendNodeId: 2,
        annotations: { readOnly: true, autosubmit: true }
      })
    )!
    expect(form).toMatchObject({ form: true, readOnly: false, autosubmit: true })
  })
})

describe('WebMcpPageTools', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps only the top-level document tools and clears them when it navigates', () => {
    const page = pageWith(tool('add_item'), tool('frame_tool', { frameId: 'child' }))
    expect(page.snapshot()).toMatchObject({
      origin: ORIGIN,
      url: `${ORIGIN}/cart`,
      tools: [{ name: 'add_item' }]
    })
    const before = page.snapshot().document
    page.handle('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'x' } })
    expect(page.snapshot().tools).toHaveLength(1)
    navigate(page, 'https://other.example/')
    expect(page.snapshot()).toMatchObject({ origin: 'https://other.example', tools: [] })
    expect(page.snapshot().document).toBe(before + 1)
  })

  it('removes a tool the page unregisters, and keeps tools across same-document navigation', () => {
    const page = pageWith(tool('add_item'), tool('get_cart'))
    page.handle('Page.navigatedWithinDocument', { frameId: 'main', url: `${ORIGIN}/cart#2` })
    page.handle('WebMCP.toolsRemoved', { tools: [{ name: 'get_cart', frameId: 'main' }] })
    expect(page.snapshot()).toMatchObject({
      url: `${ORIGIN}/cart#2`,
      tools: [{ name: 'add_item' }]
    })
  })

  it('keeps at most WEBMCP_MAX_TOOLS tools and counts the rest', () => {
    const page = pageWith(
      ...Array.from({ length: WEBMCP_MAX_TOOLS + 3 }, (_, index) => tool(`tool_${index}`))
    )
    expect(page.snapshot().tools).toHaveLength(WEBMCP_MAX_TOOLS)
    expect(page.snapshot().omitted).toBe(3)
  })

  it('lets a listed tool be called on its own origin and document', () => {
    const page = pageWith(tool('add_item'))
    page.list()
    expect(page.callable(ORIGIN, 'add_item')).toMatchObject({
      tool: { name: 'add_item' },
      frameId: 'main'
    })
  })

  it('refuses every call the listing does not cover, before anything runs', () => {
    const page = pageWith(tool('add_item'), tool('get_cart'))
    expect(refusal(() => page.callable(ORIGIN, 'add_item')).code).toBe('not_listed')
    page.list()
    expect(refusal(() => page.callable('https://evil.example', 'add_item')).code).toBe(
      'cross_origin'
    )
    expect(refusal(() => page.callable(ORIGIN, 'missing')).code).toBe('not_found')

    page.handle('WebMCP.toolsAdded', { tools: [tool('add_item', { description: 'changed' })] })
    expect(refusal(() => page.callable(ORIGIN, 'add_item')).code).toBe('changed')

    page.handle('WebMCP.toolsRemoved', { tools: [{ name: 'get_cart', frameId: 'main' }] })
    expect(refusal(() => page.callable(ORIGIN, 'get_cart')).code).toBe('not_found')

    // The same origin's next document is another page, even with a tool of the same name.
    navigate(page, `${ORIGIN}/checkout`)
    page.handle('WebMCP.toolsAdded', { tools: [tool('add_item')] })
    expect(refusal(() => page.callable(ORIGIN, 'add_item')).code).toBe('navigated')

    // Another site's tool of the same name is refused as another site's.
    navigate(page, 'https://evil.example/')
    page.handle('WebMCP.toolsAdded', { tools: [tool('add_item')] })
    expect(refusal(() => page.callable(ORIGIN, 'add_item')).code).toBe('cross_origin')
  })

  it('refuses calls on a page whose origin cannot bind them, and allows files in the project', () => {
    const page = pageWith(tool('add_item'))
    navigate(page, `${ORIGIN}/opaque`, { securityOrigin: 'null' })
    page.handle('WebMCP.toolsAdded', { tools: [tool('add_item')] })
    page.list()
    expect(refusal(() => page.callable('null', 'add_item')).code).toBe('unavailable')

    page.handle('Page.frameNavigated', {
      frame: { id: 'main', url: 'file:///project/index.html', securityOrigin: 'file://' }
    })
    page.handle('WebMCP.toolsAdded', { tools: [tool('add_item')] })
    page.list()
    expect(page.callable('file://', 'add_item').tool.name).toBe('add_item')
  })

  it('refuses calls in a tab where WebMCP could not be enabled', () => {
    const page = new WebMcpPageTools()
    page.attach({ id: 'main', url: `${ORIGIN}/`, securityOrigin: ORIGIN })
    page.list()
    expect(refusal(() => page.callable(ORIGIN, 'add_item')).code).toBe('unavailable')
  })

  it('returns the answer to an invocation, even one that came before it was awaited', async () => {
    const page = pageWith(tool('add_item'))
    const signal = new AbortController().signal
    const answer = page.awaitResult('one', { form: false, timeoutMs: 1_000, signal })
    page.handle('WebMCP.toolResponded', {
      invocationId: 'one',
      status: 'Completed',
      output: { added: 'apple' }
    })
    await expect(answer).resolves.toMatchObject({ status: 'completed', output: { added: 'apple' } })

    page.handle('WebMCP.toolResponded', { invocationId: 'two', status: 'Completed', output: 'ok' })
    await expect(
      page.awaitResult('two', { form: false, timeoutMs: 1_000, signal })
    ).resolves.toMatchObject({ status: 'completed', output: 'ok' })
  })

  it('keeps answers nobody awaits yet bounded in size and number', async () => {
    vi.useFakeTimers()
    const page = pageWith(tool('add_item'))
    const huge = 'x'.repeat(WEBMCP_MAX_RESULT_BYTES * 4)
    page.handle('WebMCP.toolResponded', { invocationId: 'big', status: 'Completed', output: huge })
    const signal = new AbortController().signal
    const big = (await page.awaitResult('big', {
      form: false,
      timeoutMs: 1_000,
      signal
    })) as Extract<WebMcpCallOutcome, { status: 'completed' }>
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(String(big.output))).toBeLessThanOrEqual(WEBMCP_MAX_RESULT_BYTES)

    for (let index = 0; index < 12; index++) {
      page.handle('WebMCP.toolResponded', {
        invocationId: `early-${index}`,
        status: 'Completed',
        output: index
      })
    }
    await expect(
      page.awaitResult('early-11', { form: false, timeoutMs: 1_000, signal })
    ).resolves.toMatchObject({ output: 11 })
    const evicted = page.awaitResult('early-0', { form: false, timeoutMs: 1_000, signal })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(evicted).resolves.toEqual({ status: 'timeout' })
  })

  it('times out, and reports a stopped run as cancelled', async () => {
    vi.useFakeTimers()
    const page = pageWith(tool('slow'))
    const timedOut = page.awaitResult('slow', {
      form: false,
      timeoutMs: 30_000,
      signal: new AbortController().signal
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(timedOut).resolves.toEqual({ status: 'timeout' })

    const controller = new AbortController()
    const stopped = page.awaitResult('stopped', {
      form: false,
      timeoutMs: 30_000,
      signal: controller.signal
    })
    controller.abort()
    await expect(stopped).resolves.toEqual({ status: 'cancelled' })
  })

  it('reports a script tool whose page navigated as navigated, since Chromium never answers it', async () => {
    vi.useFakeTimers()
    const page = pageWith(tool('checkout'))
    const answer = page.awaitResult('nav', {
      form: false,
      timeoutMs: 30_000,
      signal: new AbortController().signal
    })
    navigate(page, `${ORIGIN}/done`)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(answer).resolves.toEqual({ status: 'navigated', url: `${ORIGIN}/done` })
  })

  it("waits for a form's answer from the page its submission loaded", async () => {
    vi.useFakeTimers()
    const page = pageWith(tool('search_flights', { backendNodeId: 2 }))
    const signal = new AbortController().signal
    const answered = page.awaitResult('form', { form: true, timeoutMs: 30_000, signal })
    navigate(page, `${ORIGIN}/results`)
    await vi.advanceTimersByTimeAsync(5_000)
    page.handle('WebMCP.toolResponded', { invocationId: 'form', status: 'Completed', output: [] })
    await expect(answered).resolves.toMatchObject({
      status: 'completed',
      output: [],
      navigatedTo: `${ORIGIN}/results`
    })

    const crossOrigin = page.awaitResult('form2', { form: true, timeoutMs: 30_000, signal })
    navigate(page, 'https://elsewhere.example/')
    page.handle('WebMCP.toolResponded', {
      invocationId: 'form2',
      status: 'Error',
      errorText: 'Cannot return tool results after a cross-origin navigation'
    })
    await expect(crossOrigin).resolves.toEqual({
      status: 'navigated',
      url: 'https://elsewhere.example/'
    })
  })

  it('ends calls still waiting when the tab closes', async () => {
    const page = pageWith(tool('slow'))
    const answer = page.awaitResult('slow', {
      form: false,
      timeoutMs: 30_000,
      signal: new AbortController().signal
    })
    page.close()
    await expect(answer).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('webMcpOutcomeFromResponse', () => {
  it('cuts a result to WEBMCP_MAX_RESULT_BYTES of JSON', () => {
    const outcome = webMcpOutcomeFromResponse({
      status: 'Completed',
      output: { big: 'é'.repeat(WEBMCP_MAX_RESULT_BYTES) }
    }) as Extract<WebMcpCallOutcome, { status: 'completed' }>
    expect(outcome.truncated).toBe(true)
    expect(Buffer.byteLength(String(outcome.output))).toBeLessThanOrEqual(WEBMCP_MAX_RESULT_BYTES)
    expect(outcome.bytes).toBeGreaterThan(WEBMCP_MAX_RESULT_BYTES)
  })

  it("reports the page's error and its cancellation", () => {
    expect(
      webMcpOutcomeFromResponse({
        status: 'Error',
        errorText: '',
        exception: { description: 'Error: out of stock', objectId: 'obj-1' }
      })
    ).toEqual({ status: 'error', message: 'Error: out of stock', exceptionObjectId: 'obj-1' })
    expect(webMcpOutcomeFromResponse({ status: 'Canceled' })).toEqual({ status: 'cancelled' })
    expect(webMcpOutcomeFromResponse({ status: 'Completed' })).toMatchObject({ output: null })
  })
})

/**
 * Chromium 150's ModelContext: registerTool returns nothing and throws on a duplicate, and execute
 * receives only its input; cancellation fires `toolcancel` at the window.
 */
function chromium150Page() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>()
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  class ModelContext {
    registerTool(definition: { name: string; execute: (...args: unknown[]) => unknown }): void {
      if (tools.has(definition.name)) throw new Error('Duplicate tool name')
      tools.set(definition.name, definition)
    }
  }
  const context: Record<string, unknown> = {
    ModelContext,
    AbortController,
    DOMException,
    Promise,
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
  }
  context.globalThis = context
  runInNewContext(WEBMCP_COMPATIBILITY_SCRIPT, context)
  const modelContext = new ModelContext()
  return {
    modelContext,
    execute: (name: string, input: unknown, ...rest: unknown[]) =>
      Promise.resolve(tools.get(name)!.execute(input, ...rest)),
    cancel: (toolName: string) => {
      for (const listener of listeners.get('toolcancel') ?? []) listener({ toolName })
    }
  }
}

describe('WEBMCP_COMPATIBILITY_SCRIPT', () => {
  it('makes registerTool return a promise, rejecting instead of throwing', async () => {
    const page = chromium150Page()
    const first = page.modelContext.registerTool({ name: 'a', execute: () => 1 }) as unknown
    await expect(first).resolves.toBeUndefined()
    const duplicate = page.modelContext.registerTool({ name: 'a', execute: () => 1 }) as unknown
    await expect(duplicate).rejects.toThrow('Duplicate tool name')
  })

  it('gives execute a signal that aborts when Chromium cancels the call', async () => {
    const page = chromium150Page()
    let seen: AbortSignal | undefined
    void page.modelContext.registerTool({
      name: 'wait',
      execute: (_input: unknown, options: { signal: AbortSignal }) => {
        seen = options.signal
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason))
        )
      }
    } as never)
    const running = page.execute('wait', {})
    expect(seen?.aborted).toBe(false)
    page.cancel('wait')
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })

  it("passes on Chromium's own options once it provides them, and reads inherited members", async () => {
    const page = chromium150Page()
    class Tool {
      name = 'from_class'
      description = 'A tool defined as a class'
      execute(input: unknown, options: unknown): unknown {
        return { input, options }
      }
    }
    void page.modelContext.registerTool(new Tool() as never)
    const native = { signal: new AbortController().signal }
    await expect(page.execute('from_class', { a: 1 }, native)).resolves.toEqual({
      input: { a: 1 },
      options: native
    })
  })
})
