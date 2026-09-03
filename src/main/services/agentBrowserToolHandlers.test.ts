import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { MAX_TOOL_RESULT_MEDIA_BYTES, type ToolExecutionResult } from '../../shared/agentRuntime'
import {
  AGENT_BROWSER_TOOL_NAMES,
  AgentBrowserSessionManager,
  registerBrowserToolHandlers
} from './agentBrowserToolHandlers'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { AgentToolRuntime } from './agentToolRuntime'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import type {
  BrowserActionResult,
  BrowserObservation,
  BrowserOpenInput,
  BrowserOperationOptions,
  NativeBrowserSessionService
} from './nativeBrowserSessionService'
import { ToolOutputStore } from './toolOutputStore'
import { WorkspaceReadService } from './workspaceReadService'

function observation(sessionId: string, runId = 'run-1'): BrowserObservation {
  const path = join(tmpdir(), `${sessionId}.png`)
  return {
    sessionId,
    runId,
    observedAt: 100,
    tab: {
      id: `tab-${sessionId}`,
      webContentsId: 5,
      title: 'Example',
      url: 'https://example.com/',
      active: true,
      loading: false,
      attached: false
    },
    tabs: [
      {
        id: `tab-${sessionId}`,
        webContentsId: 5,
        title: 'Example',
        url: 'https://example.com/',
        active: true,
        loading: false,
        attached: false
      }
    ],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    semanticSnapshot: '- button "Save" [ref=ax-1-1]',
    semanticNodeCount: 1,
    screenshot: {
      id: `shot-${sessionId}`,
      sessionId,
      tabId: `tab-${sessionId}`,
      path,
      url: `sidekick-browser://artifact/${sessionId}/shot.png`,
      mimeType: 'image/png',
      kind: 'viewport',
      sourceUrl: 'https://example.com/',
      width: 1280,
      height: 800,
      bytes: 100,
      sha256: sessionId.padEnd(64, '0').slice(0, 64),
      createdAt: 100,
      changed: true,
      unchangedStreak: 0
    },
    screenshotChanged: true,
    unchangedScreenshotStreak: 0,
    console: [],
    failedRequests: [],
    cursors: { console: 0, network: 0 }
  }
}

function actionResult(value: BrowserObservation, action = 'navigate'): BrowserActionResult {
  return {
    sessionId: value.sessionId,
    tabId: value.tab.id,
    action,
    targetMode: 'page',
    coordinateFallbackUsed: false,
    durationMs: 10,
    quiescence: {
      idle: true,
      waitedMs: 1,
      pendingRequests: 0,
      mutationRevision: 0,
      timedOut: false
    },
    loopProtection: { unchangedRepeatCount: 0, blockedOnNextIdenticalAction: false },
    observation: value
  }
}

function fakeService(): NativeBrowserSessionService & {
  open: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  screenshot: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
} {
  let sequence = 0
  const sessions = new Map<string, BrowserObservation>()
  const open = vi.fn(async (input: BrowserOpenInput, _options?: BrowserOperationOptions) => {
    const value = observation(`session-${++sequence}`, input.runId)
    sessions.set(value.sessionId, value)
    return value
  })
  const observe = vi.fn(async (sessionId: string) => {
    const value = sessions.get(sessionId)
    if (!value) throw new Error('Browser session not found or already closed')
    return value
  })
  const navigate = vi.fn(async (input: { sessionId: string }) => {
    const value = sessions.get(input.sessionId)
    if (!value) throw new Error('Browser session not found or already closed')
    return actionResult(value)
  })
  const close = vi.fn(async (input: { sessionId?: string }) => {
    if (input.sessionId) sessions.delete(input.sessionId)
    return {
      closedSessions: input.sessionId ? [input.sessionId] : [],
      closedTabs: input.sessionId ? [`tab-${input.sessionId}`] : []
    }
  })
  const service = {
    open,
    observe,
    navigate,
    close,
    dispose: vi.fn(async () => undefined),
    screenshot: vi.fn(async (input: { sessionId: string }) => {
      const value = sessions.get(input.sessionId)
      if (!value?.screenshot) throw new Error('Browser session not found or already closed')
      return value.screenshot
    }),
    click: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'click')
    ),
    type: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'type')
    ),
    select: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'select')
    ),
    press: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'press')
    ),
    scroll: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'scroll')
    ),
    resize: vi.fn(
      async (input: {
        sessionId: string
        viewport: { width: number; height: number; deviceScaleFactor?: number }
      }) => {
        const value = sessions.get(input.sessionId)!
        value.viewport = { ...input.viewport }
        value.screenshot = {
          ...value.screenshot!,
          width: input.viewport.width,
          height: input.viewport.height
        }
        return actionResult(value, 'resize')
      }
    ),
    hover: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'hover')
    ),
    wait: vi.fn(async (input: { sessionId: string }) => sessions.get(input.sessionId)!),
    tabs: vi.fn(async (input: { sessionId: string }) => {
      const value = sessions.get(input.sessionId)!
      return {
        sessionId: input.sessionId,
        activeTabId: value.tab.id,
        tabs: value.tabs,
        observation: value
      }
    }),
    console: vi.fn(async () => ({ entries: [], cursor: 0 })),
    network: vi.fn(async () => ({ failures: [], cursor: 0 })),
    evaluate: vi.fn(async (input: { sessionId: string }) => ({
      sessionId: input.sessionId,
      tabId: `tab-${input.sessionId}`,
      value: { ok: true },
      serializedBytes: 11,
      truncated: false
    }))
  }
  return service as unknown as ReturnType<typeof fakeService>
}

function setup(maxConversationSessions = 6): {
  registry: AgentToolHandlerRegistry
  service: ReturnType<typeof fakeService>
  manager: AgentBrowserSessionManager
} {
  const registry = new AgentToolHandlerRegistry()
  const service = fakeService()
  const manager = new AgentBrowserSessionManager(service, { maxConversationSessions })
  registerBrowserToolHandlers(
    registry,
    manager,
    new ToolOutputStore(join(tmpdir(), `sidekick-browser-handler-output-${Math.random()}`))
  )
  return { registry, service, manager }
}

function execute(
  registry: AgentToolHandlerRegistry,
  name: string,
  args: Record<string, unknown>,
  input: {
    runId?: string
    conversationId?: string
    workspaceRoot?: string
    signal?: AbortSignal
  } = {}
): Promise<ToolExecutionResult> {
  return registry.execute({
    name,
    title: name,
    arguments: args,
    context: {
      runId: input.runId ?? 'run-1',
      conversationId: input.conversationId ?? 'conversation-1',
      workspaceRoot: input.workspaceRoot,
      signal: input.signal ?? new AbortController().signal
    }
  })
}

describe('native browser agent tool handlers', () => {
  it('registers every browser catalog tool and returns screenshots as real vision media', async () => {
    const { registry, service } = setup()
    for (const name of AGENT_BROWSER_TOOL_NAMES) expect(registry.has(name), name).toBe(true)

    const signal = new AbortController().signal
    const result = await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/' },
      { workspaceRoot: 'C:\\project', signal }
    )

    expect(result).toMatchObject({
      status: 'success',
      data: {
        screenshot: {
          url: 'sidekick-browser://artifact/session-1/shot.png'
        }
      },
      media: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { type: 'file', path: expect.stringContaining('session-1.png') }
        }
      ]
    })
    expect((result.data as { screenshot: { path?: string } }).screenshot.path).toBeUndefined()
    expect(service.open.mock.calls[0][0]).toMatchObject({
      runId: 'run-1',
      allowedFileRoots: ['C:\\project']
    })
    expect(service.open.mock.calls[0][1]).toEqual({ signal })
  })

  it('reuses the conversation browser across follow-up runs', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const result = await execute(
      registry,
      'browser_observe',
      {},
      { runId: 'run-2', conversationId: 'conversation-1' }
    )

    expect(result.status).toBe('success')
    expect(service.open).toHaveBeenCalledTimes(1)
    expect(service.observe).toHaveBeenCalledWith(
      'session-1',
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('auto-opens a conversation browser for first-use URL navigation', async () => {
    const { registry, service } = setup()
    const result = await execute(registry, 'browser_navigate', {
      action: 'url',
      url: 'https://example.com/first'
    })

    expect(result).toMatchObject({ status: 'success', media: [{ mimeType: 'image/png' }] })
    expect(service.open).toHaveBeenCalledTimes(1)
    expect(service.navigate).not.toHaveBeenCalled()
  })

  it('keeps lower actionable controls in compact routine results without repeating images', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const value = observation('session-1')
    value.semanticNodeCount = 405
    value.semanticSnapshot = [
      '- document "Long form"',
      ...Array.from({ length: 400 }, (_, index) =>
        `  - option "Country ${index}" [ref=ax-1-${index + 10}]`
      ),
      '  - combobox "State" [ref=ax-1-900]',
      '  - button "Submit search" [ref=ax-1-901]'
    ].join('\n')
    vi.mocked(service.click).mockResolvedValueOnce(actionResult(value, 'click'))

    const result = await execute(registry, 'browser_click', { ref: 'ax-1-1' })

    expect(result.status).toBe('success')
    expect(result.media).toBeUndefined()
    expect(result.modelContent).toContain('combobox \\"State\\"')
    expect(result.modelContent).toContain('button \\"Submit search\\"')
    expect(result.modelContent).toContain('semantic snapshot prioritized')
    expect(result.modelContent).not.toContain('Country 399')
  })

  it('attaches vision for coordinate actions and exposes action-specific semantic roles', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const coordinate = await execute(registry, 'browser_click', { x: 100, y: 200 })
    expect(coordinate).toMatchObject({ status: 'success', media: [{ mimeType: 'image/png' }] })

    await execute(registry, 'browser_type', { text: 'State', value: 'Nevada' })
    expect(service.type).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          name: 'State',
          preferredRoles: ['textbox', 'searchbox', 'combobox', 'spinbutton']
        })
      }),
      expect.any(Object)
    )
  })

  it('replaces a persistent session when the conversation moves to another project', async () => {
    const { registry, service } = setup()
    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/' },
      { workspaceRoot: 'C:\\one' }
    )
    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/next' },
      { runId: 'run-2', workspaceRoot: 'C:\\two' }
    )

    expect(service.close).toHaveBeenCalledWith({
      sessionId: 'session-1',
      deleteArtifacts: false
    })
    expect(service.open).toHaveBeenCalledTimes(2)
    expect(service.open.mock.calls[1][0]).toMatchObject({ allowedFileRoots: ['C:\\two'] })
  })

  it('evicts the oldest inactive conversation before the native service limit', async () => {
    const { registry, service } = setup(2)
    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/a' },
      { conversationId: 'a' }
    )
    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/b' },
      { conversationId: 'b' }
    )
    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/c' },
      { conversationId: 'c' }
    )

    expect(service.close).toHaveBeenCalledWith({
      sessionId: 'session-1',
      deleteArtifacts: false
    })
    expect(service.open).toHaveBeenCalledTimes(3)
  })

  it('records visual verification as evidence that the model must judge', async () => {
    const { registry } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const result = await execute(registry, 'browser_verify', {
      criterion: 'The save button is visible and aligned.'
    })

    expect(result).toMatchObject({
      status: 'success',
      data: {
        passed: null,
        requiresModelJudgement: true,
        verification: {
          status: 'evidence',
          summary: 'The save button is visible and aligned.',
          passed: null,
          requiresModelJudgement: true
        }
      },
      media: [{ type: 'image', mimeType: 'image/png' }]
    })
  })

  it('resizes an existing viewport and attaches the post-resize screenshot', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const result = await execute(registry, 'browser_resize', {
      width: 390,
      height: 844,
      device_scale_factor: 2
    })

    expect(service.resize).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 }
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result).toMatchObject({
      status: 'success',
      data: {
        action: 'resize',
        observation: {
          viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
          screenshot: { width: 390, height: 844 }
        }
      },
      media: [{ mimeType: 'image/png' }]
    })
  })

  it('keeps browser evaluation inspection-only and returns compact data without an observation', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const result = await execute(registry, 'browser_evaluate', {
      expression: '({ title: document.title, open: Boolean(document.querySelector("dialog")) })'
    })

    expect(result).toMatchObject({
      status: 'success',
      data: {
        value: { ok: true },
        serializedBytes: 11,
        truncated: false
      }
    })
    expect(result.data).not.toHaveProperty('observation')
    expect(result.media).toBeUndefined()
    expect(result.modelContent).not.toContain('semanticSnapshot')
    expect(service.observe).not.toHaveBeenCalled()
  })

  it('rejects synthetic browser interaction through evaluation and points to real actions', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const result = await execute(registry, 'browser_evaluate', {
      expression: 'document.querySelector("button")?.dispatchEvent(new MouseEvent("click"))'
    })

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'invalid_arguments',
        message: expect.stringContaining('must be inspection-only')
      }
    })
    expect(result.error?.message).toContain('browser_click')
    expect(service.evaluate).not.toHaveBeenCalled()
  })

  it('omits an oversized full-page image and attaches a bounded viewport fallback', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const fullPage = observation('session-1')
    fullPage.screenshot = {
      ...fullPage.screenshot!,
      kind: 'fullPage',
      bytes: MAX_TOOL_RESULT_MEDIA_BYTES + 1
    }
    const viewport = {
      ...fullPage.screenshot,
      id: 'viewport-fallback',
      kind: 'viewport' as const,
      path: join(tmpdir(), 'viewport-fallback.png'),
      bytes: 10_000
    }
    service.observe.mockResolvedValueOnce(fullPage)
    service.screenshot.mockResolvedValueOnce(viewport)

    const result = await execute(registry, 'browser_verify', {
      criterion: 'The complete page has no horizontal overflow.',
      full_page: true
    })

    expect(result).toMatchObject({
      status: 'success',
      data: {
        visualAttachment: 'omitted_too_large',
        visualAttachmentBytes: MAX_TOOL_RESULT_MEDIA_BYTES + 1,
        visualFallback: 'viewport_attached',
        visualFallbackBytes: 10_000
      },
      media: [
        {
          source: { type: 'file', path: expect.stringContaining('viewport-fallback.png') }
        }
      ]
    })
    expect(result.modelContent).toContain('"visualAttachment":"omitted_too_large"')
  })

  it('clears a stale scope mapping so browser_open can recover', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    service.observe.mockRejectedValueOnce(new Error('Browser session not found or already closed'))
    const missing = await execute(registry, 'browser_observe', {})
    expect(missing).toMatchObject({ status: 'error', error: { code: 'not_found' } })

    await execute(registry, 'browser_open', { url: 'https://example.com/recovered' })
    expect(service.open).toHaveBeenCalledTimes(2)
  })

  it('is exposed by AgentToolRuntime only with an injected native service and disposes it', async () => {
    const service = fakeService()
    const db = new Database(':memory:')
    applyDatabaseSchema(db)
    const root = join(tmpdir(), `sidekick-browser-runtime-${Math.random()}`)
    const runtime = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      new CommandService(db, join(root, 'commands')),
      new ToolOutputStore(join(root, 'outputs')),
      new McpClientManager(),
      undefined,
      undefined,
      service
    )
    const session = await runtime.createSession({
      runId: 'runtime-run',
      surface: 'conversation',
      workspaceRoot: root,
      webSearchEnabled: false,
      browserEnabled: true
    })

    expect(session.catalog().browserEnabled).toBe(true)
    await expect(
      session.router.execute(
        'browser_open',
        { url: 'https://example.com/' },
        {
          runId: 'runtime-run',
          conversationId: 'runtime-conversation',
          workspaceRoot: root,
          signal: new AbortController().signal
        }
      )
    ).resolves.toMatchObject({ status: 'success', media: [{ mimeType: 'image/png' }] })
    await runtime.close()
    expect(service.dispose).toHaveBeenCalledTimes(1)
    db.close()
  })
})
