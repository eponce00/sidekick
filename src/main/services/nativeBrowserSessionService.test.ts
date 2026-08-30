import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NativeBrowserSessionService,
  type BrowserViewport,
  type NativeBrowserRuntime,
  type NativeBrowserSurface,
  type NativeBrowserSurfaceCapture,
  type NativeBrowserSurfaceConsoleMessage,
  type NativeBrowserSurfaceLoadFailure
} from './nativeBrowserSessionService'

class FakeSurface implements NativeBrowserSurface {
  readonly attached: boolean
  url = ''
  title = 'Test page'
  destroyed = false
  loading = false
  screenshot = Buffer.from('same-png')
  fullPageScreenshot = Buffer.from('full-page-png')
  mutationRevision = 0
  bodyText = 'Welcome to SideKick'
  rejectCommittedBlank = false
  failBlankBeforeCommitAttempts = 0
  focused = false
  debuggerAttached = false
  insertedText = ''
  readonly inputEvents: Array<Parameters<NativeBrowserSurface['sendInputEvent']>[0]> = []
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  private guard: (url: string) => boolean = (url) => url === 'about:blank'
  private requestGuard: (url: string) => boolean = () => false
  private readonly consoleListeners = new Set<
    (message: NativeBrowserSurfaceConsoleMessage) => void
  >()
  private readonly failureListeners = new Set<(failure: NativeBrowserSurfaceLoadFailure) => void>()
  private readonly debuggerListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >()
  private readonly destroyedListeners = new Set<() => void>()
  private readonly openListeners = new Set<(url: string) => void>()

  constructor(
    readonly webContentsId: number,
    attached = false,
    readonly viewport: BrowserViewport = { width: 1280, height: 800, deviceScaleFactor: 1 }
  ) {
    this.attached = attached
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isLoading(): boolean {
    return this.loading
  }

  async loadURL(url: string): Promise<void> {
    if (!this.guard(url)) throw new Error(`Fake navigation guard rejected ${url}`)
    if (url === 'about:blank' && this.failBlankBeforeCommitAttempts > 0) {
      this.failBlankBeforeCommitAttempts--
      throw new Error("ERR_FAILED (-2) loading 'about:blank'")
    }
    this.url = url
    this.emitDebugger('Page.frameNavigated', { frame: { id: 'main' } })
    if (url === 'about:blank' && this.rejectCommittedBlank) {
      throw new Error("ERR_FAILED (-2) loading 'about:blank'")
    }
  }

  stop(): void {
    this.loading = false
  }

  async close(): Promise<void> {
    if (this.attached) return
    this.destroyed = true
    for (const listener of this.destroyedListeners) listener()
  }

  focus(): void {
    this.focused = true
  }

  async insertText(text: string): Promise<void> {
    this.insertedText += text
  }

  sendInputEvent(event: Parameters<NativeBrowserSurface['sendInputEvent']>[0]): void {
    this.inputEvents.push(event)
  }

  resizeViewport(viewport: BrowserViewport): void {
    this.viewport.width = viewport.width
    this.viewport.height = viewport.height
    this.viewport.deviceScaleFactor = viewport.deviceScaleFactor
  }

  async executeJavaScript<T>(source: string): Promise<T> {
    if (source === 'document.readyState') return 'complete' as T
    if (source.includes('window.innerWidth')) {
      return {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: this.viewport.deviceScaleFactor ?? 1
      } as T
    }
    if (source.includes("Symbol.for('io.sidekick.browser.mutation-state')")) {
      return this.mutationRevision as T
    }
    if (source.includes('document.body.innerText.includes')) {
      const encoded = source.match(/includes\((.*)\) : false/)?.[1]
      const text = encoded ? (JSON.parse(encoded) as string) : ''
      return this.bodyText.includes(text) as T
    }
    if (source.includes('let value = await (0, eval)')) {
      return { json: '{"answer":42}', truncated: false } as T
    }
    return undefined as T
  }

  async captureViewport(): Promise<NativeBrowserSurfaceCapture> {
    return {
      png: Buffer.from(this.screenshot),
      width: this.viewport.width,
      height: this.viewport.height
    }
  }

  async attachDebugger(): Promise<void> {
    this.debuggerAttached = true
  }

  detachDebugger(): void {
    this.debuggerAttached = false
  }

  async sendDebuggerCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.commands.push({ method, params })
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            nodeId: 'root',
            role: { value: 'RootWebArea' },
            name: { value: 'Test page' },
            backendDOMNodeId: 1,
            childIds: ['button', 'select']
          },
          {
            nodeId: 'button',
            parentId: 'root',
            role: { value: 'button' },
            name: { value: 'Save' },
            backendDOMNodeId: 9
          },
          {
            nodeId: 'select',
            parentId: 'root',
            role: { value: 'combobox' },
            name: { value: 'Language' },
            backendDOMNodeId: 10
          }
        ]
      } as T
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: `object-${String(params?.backendNodeId)}` } } as T
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T
    if (method === 'DOM.querySelectorAll') return { nodeIds: [99] } as T
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 9 } } as T
    if (method === 'Runtime.callFunctionOn') {
      const declaration = String(params?.functionDeclaration ?? '')
      if (declaration.includes('getBoundingClientRect')) {
        return {
          result: { value: { x: 20, y: 30, pageX: 20, pageY: 30, width: 100, height: 40 } }
        } as T
      }
      return { result: { value: true } } as T
    }
    if (method === 'Page.getLayoutMetrics') {
      return { cssContentSize: { x: 0, y: 0, width: 900, height: 1600 } } as T
    }
    if (method === 'Page.captureScreenshot') {
      return { data: this.fullPageScreenshot.toString('base64') } as T
    }
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: 1,
        entries: [
          { id: 1, url: 'https://previous.example/' },
          { id: 2, url: this.url || 'https://example.com/' }
        ]
      } as T
    }
    return {} as T
  }

  setNavigationGuard(guard: (url: string) => boolean): void {
    this.guard = guard
  }

  setRequestGuard(guard: (url: string) => boolean): void {
    this.requestGuard = guard
  }

  requestAllowed(url: string): boolean {
    return this.requestGuard(url)
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
    this.openListeners.add(listener)
    return () => this.openListeners.delete(listener)
  }

  emitConsole(message: NativeBrowserSurfaceConsoleMessage): void {
    for (const listener of this.consoleListeners) listener(message)
  }

  emitFailure(failure: NativeBrowserSurfaceLoadFailure): void {
    for (const listener of this.failureListeners) listener(failure)
  }

  emitDebugger(method: string, params: Record<string, unknown>): void {
    for (const listener of this.debuggerListeners) listener(method, params)
  }
}

class FakeRuntime implements NativeBrowserRuntime {
  readonly surfaces: FakeSurface[] = []
  readonly attachable = new Map<number, FakeSurface>()
  private nextId = 100
  autoCommitBlank = true
  rejectCommittedBlank = false
  failBlankBeforeCommitAttempts = 0

  async createSurface(options: {
    partition: string
    viewport: BrowserViewport
  }): Promise<NativeBrowserSurface> {
    expect(options.partition).toMatch(/^sidekick-browser-/)
    const surface = new FakeSurface(this.nextId++, false, options.viewport)
    if (this.autoCommitBlank) surface.url = 'about:blank'
    surface.rejectCommittedBlank = this.rejectCommittedBlank
    surface.failBlankBeforeCommitAttempts = this.failBlankBeforeCommitAttempts
    this.surfaces.push(surface)
    return surface
  }

  async attachSurface(webContentsId: number): Promise<NativeBrowserSurface> {
    const surface = this.attachable.get(webContentsId)
    if (!surface) throw new Error('Missing fake attachment')
    return surface
  }
}

const roots: string[] = []

async function testService(
  overrides: Partial<ConstructorParameters<typeof NativeBrowserSessionService>[0]> = {}
): Promise<{
  service: NativeBrowserSessionService
  runtime: FakeRuntime
  artifacts: string
}> {
  const artifacts = await mkdtemp(join(tmpdir(), 'sidekick-native-browser-artifacts-'))
  roots.push(artifacts)
  const runtime = new FakeRuntime()
  const service = new NativeBrowserSessionService({
    artifactRoot: artifacts,
    runtime,
    ...overrides
  })
  return { service, runtime, artifacts }
}

async function pngFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.png')) result.push(path)
    }
  }
  await visit(root)
  return result
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NativeBrowserSessionService', () => {
  it('opens an embedded session and returns a semantic, multimodal observation', async () => {
    const { service, runtime } = await testService()
    const observation = await service.open({ runId: 'run-1', url: 'https://example.com/' })

    expect(observation.sessionId).toBeTruthy()
    expect(observation.tab.url).toBe('https://example.com/')
    expect(observation.semanticSnapshot).toContain('button "Save"')
    expect(observation.semanticSnapshot).toMatch(/ref=ax-\d+-9/)
    expect(observation.screenshot).toMatchObject({
      mimeType: 'image/png',
      sourceUrl: 'https://example.com/',
      changed: null
    })
    expect(observation.screenshot?.url).toMatch(/^sidekick-browser:\/\/artifact\//)
    expect(await readFile(observation.screenshot!.path)).toEqual(Buffer.from('same-png'))
    expect(runtime.surfaces).toHaveLength(1)

    await service.dispose()
  })

  it('accepts Electron ERR_FAILED when about:blank actually committed', async () => {
    const { service, runtime } = await testService()
    runtime.autoCommitBlank = false
    runtime.rejectCommittedBlank = true

    const observation = await service.open({ runId: 'blank-quirk', url: 'https://example.com/' })

    expect(observation.tab.url).toBe('https://example.com/')
    expect(runtime.surfaces[0].debuggerAttached).toBe(true)
  })

  it('retries one transient ERR_FAILED before about:blank commits', async () => {
    const { service, runtime } = await testService()
    runtime.autoCommitBlank = false
    runtime.failBlankBeforeCommitAttempts = 1

    const observation = await service.open({ runId: 'blank-retry', url: 'https://example.com/' })

    expect(observation.tab.url).toBe('https://example.com/')
    expect(runtime.surfaces[0].debuggerAttached).toBe(true)
  })

  it('allows HTTPS, loopback development HTTP, and granted project files only', async () => {
    const { service, runtime } = await testService()
    await expect(
      service.open({ runId: 'remote-http', url: 'http://example.com/' })
    ).rejects.toThrow('loopback')
    const local = await service.open({ runId: 'local-http', url: 'http://127.0.0.1:5173/' })
    await service.close({ sessionId: local.sessionId })
    await expect(service.open({ runId: 'script', url: 'javascript:alert(1)' })).rejects.toThrow(
      'Only HTTPS'
    )

    const project = await mkdtemp(join(tmpdir(), 'sidekick-browser-project-'))
    const outside = await mkdtemp(join(tmpdir(), 'sidekick-browser-outside-'))
    roots.push(project, outside)
    const insideFile = join(project, 'index.html')
    const outsideFile = join(outside, 'index.html')
    await writeFile(insideFile, '<h1>Inside</h1>')
    await writeFile(outsideFile, '<h1>Outside</h1>')
    const fileSession = await service.open({
      runId: 'file',
      url: pathToFileURL(insideFile).href,
      allowedFileRoots: [project]
    })
    const fileSurface = runtime.surfaces.at(-1)!
    expect(fileSurface.requestAllowed(pathToFileURL(insideFile).href)).toBe(true)
    expect(fileSurface.requestAllowed(pathToFileURL(outsideFile).href)).toBe(false)
    expect(fileSurface.requestAllowed('https://cdn.example/app.js')).toBe(true)
    await service.close({ sessionId: fileSession.sessionId })
    await expect(
      service.open({
        runId: 'outside',
        url: pathToFileURL(outsideFile).href,
        allowedFileRoots: [project]
      })
    ).rejects.toThrow('approved project root')
  })

  it('returns console and failed-request deltas without losing bounded history', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'telemetry', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.emitConsole({ level: 'error', message: 'render failed', sourceId: 'app.js' })
    surface.emitDebugger('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Script',
      request: { url: 'https://example.com/app.js', method: 'GET' }
    })
    surface.emitDebugger('Network.loadingFailed', {
      requestId: 'r1',
      errorText: 'net::ERR_FAILED',
      canceled: false
    })

    const observation = await service.observe(opened.sessionId, { screenshot: 'none' })
    expect(observation.console).toEqual([
      expect.objectContaining({ level: 'error', message: 'render failed' })
    ])
    expect(observation.failedRequests).toEqual([
      expect.objectContaining({ url: 'https://example.com/app.js', errorText: 'net::ERR_FAILED' })
    ])
    const second = await service.observe(opened.sessionId, { screenshot: 'none' })
    expect(second.console).toEqual([])
    expect(second.failedRequests).toEqual([])
    expect((await service.console({ sessionId: opened.sessionId })).entries).toHaveLength(1)
    expect((await service.network({ sessionId: opened.sessionId })).failures).toHaveLength(1)
  })

  it('uses semantic targets first, coordinates only as fallback, and blocks unchanged loops', async () => {
    const { service, runtime } = await testService({ maxRepeatedNoChangeActions: 2 })
    const opened = await service.open({ runId: 'actions', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    const first = await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Save', coordinates: { x: 5, y: 6 } }
    })
    expect(first.targetMode).toBe('semantic')
    expect(first.coordinateFallbackUsed).toBe(false)
    expect(first.observation.screenshotChanged).toBe(false)
    expect(first.observation.pointer).toMatchObject({
      x: 70,
      y: 50,
      action: 'click',
      targetMode: 'semantic'
    })
    expect(surface.inputEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mouseDown', x: 70, y: 50 })])
    )

    const fallback = await service.hover({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Missing', coordinates: { x: 11, y: 12 } }
    })
    expect(fallback).toMatchObject({ targetMode: 'coordinates', coordinateFallbackUsed: true })
    expect(fallback.observation.pointer).toMatchObject({
      x: 11,
      y: 12,
      action: 'hover',
      targetMode: 'coordinates'
    })

    const selector = await service.hover({
      sessionId: opened.sessionId,
      target: { selector: '#save' }
    })
    expect(selector).toMatchObject({ targetMode: 'selector', coordinateFallbackUsed: false })

    await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Save' }
    })
    await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Save' }
    })
    await expect(
      service.click({
        sessionId: opened.sessionId,
        target: { role: 'button', name: 'Save' }
      })
    ).rejects.toMatchObject({ name: 'BrowserLoopError', code: 'BROWSER_REPEATED_NO_CHANGE' })

    const back = await service.navigate({ sessionId: opened.sessionId, action: 'back' })
    expect(back.action).toBe('navigate:back')
    expect(back.observation.pointer).toBeNull()
    expect(surface.commands).toContainEqual({
      method: 'Page.navigateToHistoryEntry',
      params: { entryId: 1 }
    })
  })

  it('compares visual changes against the same screenshot kind', async () => {
    const { service } = await testService()
    const opened = await service.open({ runId: 'capture-kinds', url: 'https://example.com/' })

    const firstFullPage = await service.screenshot({
      sessionId: opened.sessionId,
      kind: 'fullPage'
    })
    const secondFullPage = await service.screenshot({
      sessionId: opened.sessionId,
      kind: 'fullPage'
    })
    expect(firstFullPage.changed).toBeNull()
    expect(secondFullPage.changed).toBe(false)

    const action = await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Save' }
    })
    expect(action.observation.screenshotChanged).toBe(false)
  })

  it('resizes the owned Chromium viewport and returns fresh visual evidence', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'responsive', url: 'https://example.com/' })
    const resized = await service.resize({
      sessionId: opened.sessionId,
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 }
    })

    expect(resized).toMatchObject({
      action: 'resize',
      targetMode: 'page',
      observation: {
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        screenshot: { width: 390, height: 844 }
      }
    })
    expect(runtime.surfaces[0].commands).toContainEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: 390,
        screenHeight: 844,
        scale: 1
      }
    })
  })

  it('manages bounded tabs and preserves an attached host surface on close', async () => {
    const { service, runtime } = await testService({
      maxTabsPerSession: 2,
      maxSessionsPerRun: 1
    })
    const opened = await service.open({ runId: 'tabs', url: 'https://example.com/' })
    await expect(service.open({ runId: 'tabs', url: 'https://another.example/' })).rejects.toThrow(
      'maximum 1 browser sessions'
    )
    const added = await service.tabs({
      sessionId: opened.sessionId,
      action: 'new',
      url: 'https://sidekick.example/'
    })
    expect(added.tabs).toHaveLength(2)
    await expect(service.tabs({ sessionId: opened.sessionId, action: 'new' })).rejects.toThrow(
      'tab limit'
    )

    const attached = new FakeSurface(42, true)
    attached.url = 'https://attached.example/'
    runtime.attachable.set(42, attached)
    const attachedObservation = await service
      .open({
        runId: 'attached',
        attachWebContentsId: 42
      })
      .catch((error) => error)
    expect(attachedObservation).toBeInstanceOf(Error)

    const approved = await testService({
      allowedAttachWebContentsIds: new Set([42]),
      runtime
    })
    const approvedObservation = await approved.service.open({
      runId: 'attached',
      attachWebContentsId: 42
    })
    await approved.service.close({ sessionId: approvedObservation.sessionId })
    expect(attached.destroyed).toBe(false)
  })

  it('deletes only the requested tab artifacts', async () => {
    const { service, artifacts } = await testService({ maxTabsPerSession: 2 })
    const opened = await service.open({ runId: 'tab-artifacts', url: 'https://example.com/' })
    const added = await service.tabs({
      sessionId: opened.sessionId,
      action: 'new',
      url: 'https://sidekick.example/'
    })
    await service.screenshot({ sessionId: opened.sessionId, tabId: added.activeTabId })

    expect((await pngFiles(artifacts)).length).toBeGreaterThanOrEqual(2)
    await service.close({
      sessionId: opened.sessionId,
      tabId: opened.tab.id,
      deleteArtifacts: true
    })

    const remaining = await pngFiles(artifacts)
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every((path) => path.includes(added.activeTabId))).toBe(true)
  })

  it('enforces artifact count and supports cancellation and evaluation/verification', async () => {
    const { service, artifacts } = await testService({ maxArtifacts: 2 })
    const opened = await service.open({ runId: 'artifacts', url: 'https://example.com/' })
    await service.screenshot({ sessionId: opened.sessionId })
    await service.screenshot({ sessionId: opened.sessionId, kind: 'fullPage' })
    await service.screenshot({
      sessionId: opened.sessionId,
      kind: 'element',
      target: { selector: '#save' }
    })
    expect(await pngFiles(artifacts)).toHaveLength(2)

    expect(
      await service.evaluate({ sessionId: opened.sessionId, expression: '6 * 7' })
    ).toMatchObject({
      value: { answer: 42 },
      truncated: false
    })
    const verified = await service.verify({
      sessionId: opened.sessionId,
      assertions: [
        { type: 'url', value: 'example.com', match: 'contains' },
        { type: 'text', text: 'SideKick', state: 'present' },
        { type: 'semantic', target: { role: 'button', name: 'Save' }, state: 'present' }
      ]
    })
    expect(verified.passed).toBe(true)

    const controller = new AbortController()
    controller.abort()
    await expect(
      service.observe(opened.sessionId, {}, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      service.observe(opened.sessionId, {}, { deadlineAt: Date.now() - 1 })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
