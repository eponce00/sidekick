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
  BrowserFillFormInput,
  BrowserFillFormResult,
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
  fillForm: ReturnType<typeof vi.fn>
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
    hold: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'hold')
    ),
    type: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'type')
    ),
    select: vi.fn(async (input: { sessionId: string }) =>
      actionResult(sessions.get(input.sessionId)!, 'select')
    ),
    fillForm: vi.fn(async (input: BrowserFillFormInput): Promise<BrowserFillFormResult> => {
      const value = sessions.get(input.sessionId)!
      const formObservation = { ...value, screenshot: undefined, screenshotChanged: null }
      return {
        sessionId: input.sessionId,
        tabId: value.tab.id,
        action: 'fill_form',
        completed: true,
        stopReason: 'completed',
        attemptedFields: input.fields.length,
        filledFields: input.fields.length,
        durationMs: 12,
        quiescence: {
          idle: true,
          waitedMs: 1,
          pendingRequests: 0,
          mutationRevision: 0,
          timedOut: false
        },
        loopProtection: { unchangedRepeatCount: 0, blockedOnNextIdenticalAction: false },
        fields: input.fields.map((field, index) => ({
          index,
          kind: field.kind,
          status: 'filled',
          targetMode: 'ref',
          verification: { passed: true }
        })),
        observation: formObservation
      }
    }),
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
    })),
    beginHumanTakeover: vi.fn(async (sessionId: string) => ({
      active: true,
      observation: sessions.get(sessionId)!
    })),
    completeHumanTakeover: vi.fn(async (sessionId: string) => ({
      active: false,
      observation: sessions.get(sessionId)!
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
      ...Array.from(
        { length: 400 },
        (_, index) => `  - option "Country ${index}" [ref=ax-1-${index + 10}]`
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
    expect(result.modelContent).toContain('400 option nodes omitted')
    expect(result.modelContent).not.toContain('Country 0')
    expect(result.modelContent).not.toContain('Country 399')
    expect(result.modelContent.length).toBeLessThan(8_000)
  })

  it('attaches vision for coordinate actions and exposes action-specific semantic roles', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const unboundCoordinate = await execute(registry, 'browser_click', { x: 100, y: 200 })
    expect(unboundCoordinate).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('screenshot_id') }
    })

    const coordinate = await execute(registry, 'browser_click', {
      x: 100,
      y: 200,
      screenshot_id: 'shot-session-1'
    })
    expect(coordinate).toMatchObject({ status: 'success', media: [{ mimeType: 'image/png' }] })
    expect(service.click).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ screenshotId: 'shot-session-1' })
      }),
      expect.any(Object)
    )

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

  it('maps atomic hold arguments and blocks agent actions while a human owns the browser', async () => {
    const { registry, service, manager } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const held = await execute(registry, 'browser_hold', {
      ref: 'ax-1-1',
      duration_ms: 750
    })
    expect(held.status).toBe('success')
    expect(service.hold).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        target: expect.objectContaining({ ref: 'ax-1-1' }),
        durationMs: 750
      }),
      expect.any(Object)
    )

    const reservedSessionId = await manager.reserveHumanTakeover('conversation-1')
    await manager.beginHumanTakeover('conversation-1', reservedSessionId)
    const raced = await execute(registry, 'browser_observe', {})
    expect(raced).toMatchObject({ status: 'error' })
    expect(raced.error?.message).toContain('Human browser takeover is pending')
    await manager.completeHumanTakeover('conversation-1', reservedSessionId)
    await manager.releaseHumanTakeover('conversation-1', reservedSessionId)
    await expect(execute(registry, 'browser_observe', {})).resolves.toMatchObject({
      status: 'success'
    })
  })

  it('validates first-use navigation before reporting a missing session', async () => {
    const { registry, service } = setup()
    const invalid = await execute(registry, 'browser_navigate', { action: 'url' })
    expect(invalid).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('requires a URL') }
    })
    expect(service.open).not.toHaveBeenCalled()
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

  it('pins the exact browser session while human takeover is pending', async () => {
    const { registry, service, manager } = setup(2)
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
    const reservedSessionId = await manager.reserveHumanTakeover('a')

    await execute(
      registry,
      'browser_open',
      { url: 'https://example.com/c' },
      { conversationId: 'c' }
    )

    expect(reservedSessionId).toBe('session-1')
    expect(service.close).toHaveBeenCalledWith({
      sessionId: 'session-2',
      deleteArtifacts: false
    })
    await expect(manager.beginHumanTakeover('a', 'different-session')).rejects.toThrow(
      'reserved browser session'
    )
    await manager.releaseHumanTakeover('a', reservedSessionId)
  })

  it('parks an active takeover when its suspended run is cancelled', async () => {
    const { registry, service, manager } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const sessionId = await manager.reserveHumanTakeover('conversation-1')
    await manager.beginHumanTakeover('conversation-1', sessionId)

    await manager.releaseHumanTakeover('conversation-1', sessionId)

    expect(service.completeHumanTakeover).toHaveBeenCalledWith(sessionId)
    await expect(execute(registry, 'browser_observe', {})).resolves.toMatchObject({
      status: 'success'
    })
  })

  it('does not close an exact session while takeover is reserved', async () => {
    const { registry, service, manager } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const sessionId = await manager.reserveHumanTakeover('conversation-1')

    await expect(manager.closeScope('conversation-1')).rejects.toThrow(
      'Human browser takeover is pending'
    )
    expect(service.close).not.toHaveBeenCalled()

    await manager.releaseHumanTakeover('conversation-1', sessionId)
    await expect(manager.closeScope('conversation-1')).resolves.toMatchObject({
      closedSessions: [sessionId]
    })
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

  it('maps a mixed form batch, returns one final observation, and never echoes field values', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const secret = 'correct horse battery staple'
    const result = await execute(registry, 'browser_fill_form', {
      fields: [
        { kind: 'textbox', ref: 'ax-1-11', value: secret },
        { kind: 'select', text: 'Language', values: ['Private selection'] },
        { kind: 'checkbox', selector: '#subscribe', checked: true },
        { kind: 'radio', ref: 'ax-1-13', checked: true }
      ]
    })

    expect(service.fillForm).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        fields: [
          { kind: 'textbox', target: { ref: 'ax-1-11' }, value: secret },
          {
            kind: 'select',
            target: { name: 'Language', exact: false },
            values: ['Private selection']
          },
          { kind: 'checkbox', target: { selector: '#subscribe' }, checked: true },
          { kind: 'radio', target: { ref: 'ax-1-13' }, checked: true }
        ]
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result).toMatchObject({
      status: 'success',
      data: {
        completed: true,
        fields: [
          { index: 0, verification: { passed: true } },
          { index: 1, verification: { passed: true } },
          { index: 2, verification: { passed: true } },
          { index: 3, verification: { passed: true } }
        ]
      }
    })
    expect((result.data as BrowserFillFormResult).observation.screenshot).toBeUndefined()
    expect(result.media).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('Private selection')
  })

  it('returns structured recovery and the final observation when a form batch stops', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const finalObservation = observation('session-1')
    finalObservation.screenshot = undefined
    finalObservation.screenshotChanged = null
    service.fillForm.mockResolvedValueOnce({
      sessionId: 'session-1',
      tabId: finalObservation.tab.id,
      action: 'fill_form',
      completed: false,
      stopReason: 'field_failed',
      attemptedFields: 1,
      filledFields: 0,
      durationMs: 10,
      quiescence: {
        idle: true,
        waitedMs: 1,
        pendingRequests: 0,
        mutationRevision: 0,
        timedOut: false
      },
      loopProtection: { unchangedRepeatCount: 0, blockedOnNextIdenticalAction: false },
      fields: [
        {
          index: 0,
          kind: 'textbox',
          status: 'failed',
          targetMode: 'ref',
          verification: { passed: false },
          error: {
            code: 'verification_failed',
            message: 'The requested form state did not match the actual control state.'
          }
        },
        { index: 1, kind: 'checkbox', status: 'skipped' }
      ],
      observation: finalObservation
    })

    const result = await execute(registry, 'browser_fill_form', {
      fields: [
        { kind: 'textbox', ref: 'ax-1-11', value: 'private failure value' },
        { kind: 'checkbox', ref: 'ax-1-12', checked: true }
      ]
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'conflict', retryable: true, recoveryAction: 'refresh_state' },
      data: {
        completed: false,
        outcome: 'failed',
        fields: [{ status: 'failed' }, { status: 'skipped' }]
      }
    })
    expect((result.data as BrowserFillFormResult).observation.screenshot).toBeUndefined()
    expect(result.media).toBeUndefined()
    expect(result.modelContent).toContain('retarget only the failed fields')
    expect(JSON.stringify(result)).not.toContain('private failure value')
  })

  it('marks a partially completed form batch explicitly without echoing values', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })
    const finalObservation = observation('session-1')
    finalObservation.screenshot = undefined
    service.fillForm.mockResolvedValueOnce({
      sessionId: 'session-1',
      tabId: finalObservation.tab.id,
      action: 'fill_form',
      completed: false,
      stopReason: 'field_failed',
      attemptedFields: 2,
      filledFields: 1,
      durationMs: 10,
      quiescence: {
        idle: true,
        waitedMs: 1,
        pendingRequests: 0,
        mutationRevision: 0,
        timedOut: false
      },
      loopProtection: { unchangedRepeatCount: 0, blockedOnNextIdenticalAction: false },
      fields: [
        { index: 0, kind: 'textbox', status: 'filled', verification: { passed: true } },
        {
          index: 1,
          kind: 'textbox',
          status: 'failed',
          verification: { passed: false },
          error: {
            code: 'verification_failed',
            message: 'The requested form state did not match the actual control state.'
          }
        }
      ],
      observation: finalObservation
    })

    const result = await execute(registry, 'browser_fill_form', {
      fields: [
        { kind: 'textbox', ref: 'ax-1-11', value: 'private first value' },
        { kind: 'textbox', ref: 'ax-1-12', value: 'private second value' }
      ]
    })

    expect(result).toMatchObject({
      status: 'error',
      data: {
        outcome: 'partial',
        recovery: { verifiedFields: 1, failedFields: 1, skippedFields: 0 }
      }
    })
    expect(result.modelContent).toContain('Do not repeat fields that were already verified')
    expect(JSON.stringify(result)).not.toContain('private first value')
    expect(JSON.stringify(result)).not.toContain('private second value')
  })

  it('rejects coordinate form targets before any browser action', async () => {
    const { registry, service } = setup()
    await execute(registry, 'browser_open', { url: 'https://example.com/' })

    const result = await execute(registry, 'browser_fill_form', {
      fields: [{ kind: 'textbox', x: 40, y: 80, value: 'must-not-run' }]
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'invalid_arguments', recoveryAction: 'correct_input' }
    })
    expect(service.fillForm).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('must-not-run')
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
