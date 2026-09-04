import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  scrollX = 0
  scrollY = 0
  bodyText = 'Welcome to SideKick'
  rejectCommittedBlank = false
  failBlankBeforeCommitAttempts = 0
  focused = false
  humanTakeoverVisible = false
  humanVerificationMarkerVisible = false
  humanVerificationSolved = false
  humanVerificationAdditionalUnresolved = false
  showChallengeAfterNextTextInput = false
  debuggerAttached = false
  insertedText = ''
  focusedBackendNodeId: number | undefined
  lastBackendNodeId: number | undefined
  selectAllPending = false
  ignoreTextInput = false
  navigateAfterTextInput = false
  navigateOnClickBackendNodeId: number | undefined
  stealFocusOnClickBackendNodeId: number | undefined
  navigateOnBackspace = false
  stealFocusOnBackspace = false
  captureWidth: number | undefined
  captureHeight: number | undefined
  captureFailures = 0
  captureAttempts = 0
  captureErrorMessage = 'UnknownVizError'
  mutateDuringCapture = false
  scrollDuringCapture = false
  navigateDuringCapture = false
  revertStandaloneSelect = false
  replaceStandaloneSelect = false
  navigateSameUrlOnStandaloneSelect = false
  selectBackendNodeId = 10
  selectorBackendNodeId = 9
  extraAxNodes: Array<Record<string, unknown>> = []
  readonly formControls = new Map<
    number,
    {
      kind: 'textbox' | 'select' | 'checkbox' | 'radio'
      value?: string
      selectedValues?: string[]
      checked?: boolean
      disabled?: boolean
      readOnly?: boolean
      multiple?: boolean
      options?: Array<{ value: string; label: string; text: string }>
    }
  >([
    [11, { kind: 'textbox', value: '' }],
    [
      10,
      {
        kind: 'select',
        selectedValues: ['en'],
        options: [
          { value: 'en', label: 'English', text: 'English' },
          { value: 'es', label: 'Spanish', text: 'Spanish' }
        ]
      }
    ],
    [12, { kind: 'checkbox', checked: false }],
    [13, { kind: 'radio', checked: false }],
    [14, { kind: 'textbox', value: '' }]
  ])
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

  showForHumanTakeover(): void {
    if (this.attached) throw new Error('This browser surface cannot be shown for human takeover')
    this.humanTakeoverVisible = true
  }

  hideHumanTakeover(): void {
    this.humanTakeoverVisible = false
  }

  isHumanTakeoverVisible(): boolean {
    return this.humanTakeoverVisible
  }

  focus(): void {
    this.focused = true
  }

  async insertText(text: string): Promise<void> {
    this.insertedText += text
    const control =
      this.focusedBackendNodeId === undefined
        ? undefined
        : this.formControls.get(this.focusedBackendNodeId)
    if (!this.ignoreTextInput && control?.kind === 'textbox') control.value = text
    this.selectAllPending = false
    if (this.showChallengeAfterNextTextInput) {
      this.showChallengeAfterNextTextInput = false
      this.humanVerificationMarkerVisible = true
      this.bodyText = 'Verify that you are a human'
    }
    if (this.navigateAfterTextInput) {
      this.navigateAfterTextInput = false
      this.url = 'https://example.com/after-input'
      this.emitDebugger('Page.frameNavigated', { frame: { id: 'main' } })
    }
  }

  sendInputEvent(event: Parameters<NativeBrowserSurface['sendInputEvent']>[0]): void {
    this.inputEvents.push(event)
    if (event.type === 'keyDown' && event.keyCode === 'A') this.selectAllPending = true
    if (event.type === 'keyDown' && event.keyCode === 'Backspace' && this.selectAllPending) {
      const control =
        this.focusedBackendNodeId === undefined
          ? undefined
          : this.formControls.get(this.focusedBackendNodeId)
      if (control?.kind === 'textbox') control.value = ''
    }
    if (event.type === 'keyUp' && event.keyCode === 'Backspace') {
      if (this.stealFocusOnBackspace) this.focusedBackendNodeId = 14
      if (this.navigateOnBackspace) {
        this.url = 'https://example.com/after-clear'
        this.emitDebugger('Page.frameNavigated', { frame: { id: 'main', url: this.url } })
      }
    }
    if (event.type === 'mouseUp' && this.lastBackendNodeId !== undefined) {
      const control = this.formControls.get(this.lastBackendNodeId)
      if (control) this.focusedBackendNodeId = this.lastBackendNodeId
      if (this.stealFocusOnClickBackendNodeId === this.lastBackendNodeId) {
        this.focusedBackendNodeId = 14
      }
      if (this.navigateOnClickBackendNodeId === this.lastBackendNodeId) {
        this.url = 'https://example.com/after-click'
        this.emitDebugger('Page.frameNavigated', { frame: { id: 'main', url: this.url } })
      }
      if (control?.kind === 'checkbox' && !control.disabled) control.checked = !control.checked
      if (control?.kind === 'radio' && !control.disabled) control.checked = true
    }
  }

  resizeViewport(viewport: BrowserViewport): void {
    this.viewport.width = viewport.width
    this.viewport.height = viewport.height
    this.viewport.deviceScaleFactor = viewport.deviceScaleFactor
  }

  async executeJavaScript<T>(source: string): Promise<T> {
    if (source === 'document.readyState') return 'complete' as T
    if (source.includes('sidekickPdfReady')) return 'ready' as T
    if (source.includes('unresolvedMarker') && source.includes('solvedKnownWidget')) {
      return {
        pageText: this.bodyText,
        unresolvedMarker:
          (this.humanVerificationMarkerVisible && !this.humanVerificationSolved) ||
          this.humanVerificationAdditionalUnresolved,
        solvedKnownWidget: this.humanVerificationSolved
      } as T
    }
    if (source.includes('io.sidekick.browser.coordinate-capture-state')) {
      return {
        sourceUrl: this.url,
        viewportWidth: this.viewport.width,
        viewportHeight: this.viewport.height,
        scrollX: this.scrollX,
        scrollY: this.scrollY,
        mutationRevision: this.mutationRevision
      } as T
    }
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
    this.captureAttempts++
    if (this.captureFailures > 0) {
      this.captureFailures--
      throw new Error(this.captureErrorMessage)
    }
    if (this.mutateDuringCapture) {
      this.mutateDuringCapture = false
      this.mutationRevision++
    }
    if (this.scrollDuringCapture) {
      this.scrollDuringCapture = false
      this.scrollY += 100
    }
    if (this.navigateDuringCapture) {
      this.navigateDuringCapture = false
      this.emitDebugger('Page.frameNavigated', { frame: { id: 'main', url: this.url } })
    }
    return {
      png: Buffer.from(this.screenshot),
      width: this.captureWidth ?? this.viewport.width,
      height: this.captureHeight ?? this.viewport.height
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
            childIds: [
              'button',
              'textbox',
              'select',
              'checkbox',
              'radio',
              'notes',
              ...this.extraAxNodes.map((node) => String(node.nodeId))
            ]
          },
          {
            nodeId: 'button',
            parentId: 'root',
            role: { value: 'button' },
            name: { value: 'Save' },
            backendDOMNodeId: 9
          },
          {
            nodeId: 'textbox',
            parentId: 'root',
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: this.formControls.get(11)?.value },
            backendDOMNodeId: 11
          },
          {
            nodeId: 'select',
            parentId: 'root',
            role: { value: 'combobox' },
            name: { value: 'Language' },
            value: { value: this.formControls.get(this.selectBackendNodeId)?.selectedValues?.[0] },
            backendDOMNodeId: this.selectBackendNodeId
          },
          {
            nodeId: 'checkbox',
            parentId: 'root',
            role: { value: 'checkbox' },
            name: { value: 'Subscribe' },
            properties: [{ name: 'checked', value: { value: this.formControls.get(12)?.checked } }],
            backendDOMNodeId: 12
          },
          {
            nodeId: 'radio',
            parentId: 'root',
            role: { value: 'radio' },
            name: { value: 'Plan A' },
            properties: [{ name: 'checked', value: { value: this.formControls.get(13)?.checked } }],
            backendDOMNodeId: 13
          },
          {
            nodeId: 'notes',
            parentId: 'root',
            role: { value: 'textbox' },
            name: { value: 'Notes' },
            value: { value: this.formControls.get(14)?.value },
            backendDOMNodeId: 14
          },
          ...this.extraAxNodes
        ]
      } as T
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: `object-${String(params?.backendNodeId)}` } } as T
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T
    if (method === 'DOM.querySelectorAll') return { nodeIds: [99] } as T
    if (method === 'DOM.describeNode') {
      return { node: { backendNodeId: this.selectorBackendNodeId } } as T
    }
    if (method === 'Runtime.callFunctionOn') {
      const declaration = String(params?.functionDeclaration ?? '')
      const backendNodeId = Number(String(params?.objectId ?? '').replace('object-', ''))
      this.lastBackendNodeId = backendNodeId
      if (declaration.includes('getBoundingClientRect')) {
        return {
          result: { value: { x: 20, y: 30, pageX: 20, pageY: 30, width: 100, height: 40 } }
        } as T
      }
      const control = this.formControls.get(backendNodeId)
      if (declaration.includes('Target text field did not retain focus')) {
        if (control?.kind !== 'textbox' || this.focusedBackendNodeId !== backendNodeId) {
          return {
            exceptionDetails: { text: 'Target text field did not retain focus' }
          } as T
        }
        return { result: { value: true } } as T
      }
      if (declaration.includes('unsupportedInputs')) {
        if (!control) {
          return {
            result: {
              value: { kind: 'unsupported', disabled: false, readOnly: false }
            }
          } as T
        }
        return {
          result: {
            value: {
              kind: control.kind,
              disabled: control.disabled ?? false,
              readOnly: control.readOnly ?? false,
              ...(control.value === undefined ? {} : { value: control.value }),
              ...(control.selectedValues === undefined
                ? {}
                : { selectedValues: [...control.selectedValues] }),
              ...(control.checked === undefined ? {} : { checked: control.checked })
            }
          }
        } as T
      }
      if (declaration.includes('expectedValues')) {
        if (control?.kind !== 'select') {
          return {
            exceptionDetails: { text: 'Target is not a select element' }
          } as T
        }
        const requested = ((params?.arguments as Array<{ value?: unknown[] }> | undefined)?.[0]
          ?.value ?? []) as string[]
        if (!control.multiple && requested.length !== 1) {
          return {
            exceptionDetails: {
              text: 'A single-select field requires exactly one requested option'
            }
          } as T
        }
        const matches = requested.map((value) =>
          control.options?.find(
            (option) => option.value === value || option.label === value || option.text === value
          )
        )
        if (matches.some((option) => !option)) {
          return {
            exceptionDetails: { text: 'One or more requested select options were not found' }
          } as T
        }
        const expectedValues = [...new Set(matches.map((option) => option!.value))]
        const changed = JSON.stringify(control.selectedValues) !== JSON.stringify(expectedValues)
        control.selectedValues = expectedValues
        return { result: { value: { changed, expectedValues } } } as T
      }
      if (declaration.includes('const chosen = new Set()')) {
        if (control?.kind !== 'select') {
          return { exceptionDetails: { text: 'Target is not a select element' } } as T
        }
        const requested = ((params?.arguments as Array<{ value?: unknown[] }> | undefined)?.[0]
          ?.value ?? []) as string[]
        const selected = requested.map((value) => {
          const exactValue = control.options?.filter((option) => option.value === value) ?? []
          const matches = exactValue.length
            ? exactValue
            : (control.options?.filter(
                (option) => option.label === value || option.text === value
              ) ?? [])
          return matches.length === 1 ? matches[0] : undefined
        })
        if (selected.some((option) => !option)) {
          return { exceptionDetails: { text: 'No select option matched one requested value' } } as T
        }
        const expected = [...new Set(selected.map((option) => option!.value))]
        control.selectedValues = this.revertStandaloneSelect ? ['en'] : expected
        if (this.replaceStandaloneSelect) {
          this.formControls.set(17, {
            ...control,
            selectedValues: [...(control.selectedValues ?? [])],
            options: control.options?.map((option) => ({ ...option }))
          })
          this.formControls.delete(backendNodeId)
          this.selectBackendNodeId = 17
        }
        if (this.navigateSameUrlOnStandaloneSelect) {
          this.emitDebugger('Page.frameNavigated', { frame: { id: 'main', url: this.url } })
        }
        return { result: { value: expected } } as T
      }
      if (declaration.includes('connected select element')) {
        if (control?.kind !== 'select') {
          return { exceptionDetails: { text: 'Target is no longer a select element' } } as T
        }
        return { result: { value: [...(control.selectedValues ?? [])] } } as T
      }
      if (declaration.includes('this.focus()')) {
        this.focusedBackendNodeId = backendNodeId
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

  emitOpenUrl(url: string): void {
    for (const listener of this.openListeners) listener(url)
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

function observedRef(observation: { semanticSnapshot?: string }, name: string): string {
  const line = observation.semanticSnapshot
    ?.split('\n')
    .find((candidate) => candidate.includes(`"${name}"`))
  const ref = line?.match(/ref=([^\s\]]+)/)?.[1]
  if (!ref) throw new Error(`Missing semantic ref for ${name}`)
  return ref
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
      target: {
        role: 'button',
        name: 'Missing',
        screenshotId: first.observation.screenshot!.id,
        coordinates: { x: 11, y: 12 }
      }
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

  it('performs an atomic bounded hold and always releases the mouse when cancelled', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'hold', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]

    const held = await service.hold({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Save' },
      durationMs: 100
    })
    expect(held.observation.pointer).toMatchObject({ action: 'hold', x: 70, y: 50 })
    expect(surface.inputEvents.slice(-3).map((input) => input.type)).toEqual([
      'mouseMove',
      'mouseDown',
      'mouseUp'
    ])

    const controller = new AbortController()
    const cancelled = service.hold(
      {
        sessionId: opened.sessionId,
        target: { role: 'button', name: 'Save' },
        durationMs: 5_000
      },
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(), 5)
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(surface.inputEvents.at(-1)).toMatchObject({ type: 'mouseUp', x: 70, y: 50 })
  })

  it('detects human verification and refuses automated click or hold input on the challenge', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'challenge', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.extraAxNodes.push({
      nodeId: 'human-check',
      parentId: 'root',
      role: { value: 'button' },
      name: { value: 'Press & Hold to confirm you are a human' },
      backendDOMNodeId: 22
    })
    surface.bodyText = 'Press & Hold to confirm you are a human'

    const observed = await service.observe(opened.sessionId, { screenshot: 'none' })
    expect(observed.humanVerification).toMatchObject({
      required: true,
      kind: 'captcha_or_bot_challenge',
      detectedBy: 'accessibility'
    })
    const inputCount = surface.inputEvents.length
    await expect(
      service.click({
        sessionId: opened.sessionId,
        target: { role: 'button', name: 'Press & Hold to confirm you are a human' }
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.hold({
        sessionId: opened.sessionId,
        target: { role: 'button', name: 'Press & Hold to confirm you are a human' },
        durationMs: 1_000
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.type({
        sessionId: opened.sessionId,
        target: { role: 'textbox', name: 'Verification answer' },
        text: 'answer'
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.select({
        sessionId: opened.sessionId,
        target: { role: 'combobox', name: 'Verification choice' },
        values: ['one']
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.fillForm({
        sessionId: opened.sessionId,
        fields: [
          {
            kind: 'textbox',
            target: { role: 'textbox', name: 'Verification answer' },
            value: 'answer'
          }
        ]
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.press({ sessionId: opened.sessionId, key: 'Enter' })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.hover({
        sessionId: opened.sessionId,
        target: { role: 'button', name: 'Press & Hold to confirm you are a human' }
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.scroll({ sessionId: opened.sessionId, deltaY: 400 })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    await expect(
      service.evaluate({ sessionId: opened.sessionId, expression: 'document.body.click()' })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    expect(surface.inputEvents).toHaveLength(inputCount)
  })

  it('treats a solved provider widget as cleared even when its static label remains', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'solved-challenge', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.bodyText = "I'm not a robot"
    surface.humanVerificationMarkerVisible = true
    surface.humanVerificationSolved = true
    surface.extraAxNodes.push({
      nodeId: 'solved-human-check',
      parentId: 'root',
      role: { value: 'checkbox' },
      name: { value: "I'm not a robot" },
      properties: [{ name: 'checked', value: { value: true } }],
      backendDOMNodeId: 23
    })

    const observed = await service.observe(opened.sessionId, { screenshot: 'none' })
    expect(observed.humanVerification).toBeNull()
    await expect(
      service.click({ sessionId: opened.sessionId, target: { role: 'button', name: 'Save' } })
    ).resolves.toMatchObject({ action: 'click' })
  })

  it('still detects another unresolved widget beside a solved provider widget', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'mixed-challenges', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.bodyText = "I'm not a robot"
    surface.humanVerificationMarkerVisible = true
    surface.humanVerificationSolved = true
    surface.humanVerificationAdditionalUnresolved = true

    const observed = await service.observe(opened.sessionId, { screenshot: 'none' })
    expect(observed.humanVerification).toMatchObject({
      required: true,
      detectedBy: 'dom_marker'
    })
  })

  it('stops a form batch if human verification appears between fields', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'mid-form-challenge', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.showChallengeAfterNextTextInput = true

    await expect(
      service.fillForm({
        sessionId: opened.sessionId,
        fields: [
          { kind: 'textbox', target: { role: 'textbox', name: 'Email' }, value: 'first' },
          { kind: 'textbox', target: { role: 'textbox', name: 'Notes' }, value: 'second' }
        ]
      })
    ).rejects.toMatchObject({ name: 'BrowserHumanVerificationError' })
    expect(surface.formControls.get(11)?.value).toBe('first')
    expect(surface.formControls.get(14)?.value).toBe('')
  })

  it('reveals and hides the same browser surface for human takeover', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'takeover', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]

    const active = await service.beginHumanTakeover(opened.sessionId)
    expect(active.active).toBe(true)
    expect(surface.humanTakeoverVisible).toBe(true)
    expect(active.observation).toMatchObject({
      sessionId: opened.sessionId,
      tab: { url: 'https://example.com/' }
    })

    const completed = await service.completeHumanTakeover(opened.sessionId)
    expect(completed.active).toBe(false)
    expect(surface.humanTakeoverVisible).toBe(false)
    expect(completed.observation).toMatchObject({
      sessionId: opened.sessionId,
      tab: { url: 'https://example.com/' }
    })
  })

  it('keeps takeover popups in the exact visible tab', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'takeover-popup', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]

    await service.beginHumanTakeover(opened.sessionId)
    surface.emitOpenUrl('https://example.com/popup')
    await vi.waitFor(() => expect(surface.url).toBe('https://example.com/popup'))

    const completed = await service.completeHumanTakeover(opened.sessionId)
    expect(runtime.surfaces).toHaveLength(1)
    expect(surface.humanTakeoverVisible).toBe(false)
    expect(completed.observation.tab.url).toBe('https://example.com/popup')
  })

  it('binds coordinate input to a current viewport screenshot and maps resized pixels', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'coordinate-binding', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.captureWidth = 640
    surface.captureHeight = 400
    const current = await service.observe(opened.sessionId)

    const hovered = await service.hover({
      sessionId: opened.sessionId,
      target: {
        screenshotId: current.screenshot!.id,
        coordinates: { x: 320, y: 200 }
      }
    })
    expect(hovered.observation.pointer).toMatchObject({ x: 640, y: 400 })

    surface.mutationRevision++
    await expect(
      service.hover({
        sessionId: opened.sessionId,
        target: {
          screenshotId: hovered.observation.screenshot!.id,
          coordinates: { x: 10, y: 10 }
        }
      })
    ).rejects.toThrow('screenshot is stale')

    await expect(
      service.hover({
        sessionId: opened.sessionId,
        target: { screenshotId: opened.screenshot!.id, coordinates: { x: 10, y: 10 } }
      })
    ).rejects.toThrow('screenshot is stale')
    await expect(
      service.hover({
        sessionId: opened.sessionId,
        target: { coordinates: { x: 10, y: 10 } }
      })
    ).rejects.toThrow('require the screenshot_id')

    for (const instability of [
      'mutateDuringCapture',
      'scrollDuringCapture',
      'navigateDuringCapture'
    ] as const) {
      surface[instability] = true
      const unstable = await service.observe(opened.sessionId)
      await expect(
        service.hover({
          sessionId: opened.sessionId,
          target: { screenshotId: unstable.screenshot!.id, coordinates: { x: 10, y: 10 } }
        })
      ).rejects.toThrow('screenshot is stale')
    }
  })

  it('filters decorative roles without silently choosing between actionable matches', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'role-filtering', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.extraAxNodes.push({
      nodeId: 'save-heading',
      parentId: 'root',
      role: { value: 'heading' },
      name: { value: 'Save' },
      backendDOMNodeId: 15
    })
    await service.observe(opened.sessionId, { screenshot: 'none' })

    const filtered = await service.click({
      sessionId: opened.sessionId,
      target: { name: 'Save', exact: true, preferredRoles: ['button', 'checkbox'] }
    })
    expect(filtered.targetMode).toBe('semantic')

    surface.extraAxNodes.push({
      nodeId: 'save-checkbox',
      parentId: 'root',
      role: { value: 'checkbox' },
      name: { value: 'Save' },
      backendDOMNodeId: 16
    })
    await service.observe(opened.sessionId, { screenshot: 'none' })
    await expect(
      service.click({
        sessionId: opened.sessionId,
        target: { name: 'Save', exact: true, preferredRoles: ['button', 'checkbox'] }
      })
    ).rejects.toThrow('ambiguous')
  })

  it('verifies a native select after settling and reports a reverted selection', async () => {
    const first = await testService()
    const opened = await first.service.open({
      runId: 'select-verified',
      url: 'https://example.com/'
    })
    const selected = await first.service.select({
      sessionId: opened.sessionId,
      target: { role: 'combobox', name: 'Language' },
      values: ['Spanish']
    })
    expect(selected.action).toBe('select')
    expect(first.runtime.surfaces[0].formControls.get(10)?.selectedValues).toEqual(['es'])

    const replacement = await testService()
    const replacementOpened = await replacement.service.open({
      runId: 'select-replaced',
      url: 'https://example.com/'
    })
    replacement.runtime.surfaces[0].replaceStandaloneSelect = true
    await expect(
      replacement.service.select({
        sessionId: replacementOpened.sessionId,
        target: { role: 'combobox', name: 'Language' },
        values: ['Spanish']
      })
    ).resolves.toMatchObject({ action: 'select' })
    expect(replacement.runtime.surfaces[0].formControls.get(17)?.selectedValues).toEqual(['es'])

    const second = await testService()
    const reverted = await second.service.open({
      runId: 'select-reverted',
      url: 'https://example.com/'
    })
    second.runtime.surfaces[0].revertStandaloneSelect = true
    await expect(
      second.service.select({
        sessionId: reverted.sessionId,
        target: { role: 'combobox', name: 'Language' },
        values: ['Spanish']
      })
    ).rejects.toThrow('did not retain')

    const fallback = await testService()
    const fallbackOpened = await fallback.service.open({
      runId: 'select-ref-with-fallback',
      url: 'https://example.com/'
    })
    const fallbackSurface = fallback.runtime.surfaces[0]
    fallbackSurface.formControls.set(18, {
      kind: 'select',
      selectedValues: ['es'],
      options: [
        { value: 'en', label: 'English', text: 'English' },
        { value: 'es', label: 'Spanish', text: 'Spanish' }
      ]
    })
    fallbackSurface.selectorBackendNodeId = 18
    fallbackSurface.revertStandaloneSelect = true
    await expect(
      fallback.service.select({
        sessionId: fallbackOpened.sessionId,
        target: {
          ref: observedRef(fallbackOpened, 'Language'),
          selector: '#different-select'
        },
        values: ['Spanish']
      })
    ).rejects.toThrow('did not retain')

    const sameUrl = await testService()
    const sameUrlOpened = await sameUrl.service.open({
      runId: 'select-same-url-navigation',
      url: 'https://example.com/'
    })
    sameUrl.runtime.surfaces[0].navigateSameUrlOnStandaloneSelect = true
    await expect(
      sameUrl.service.select({
        sessionId: sameUrlOpened.sessionId,
        target: { role: 'combobox', name: 'Language' },
        values: ['Spanish']
      })
    ).rejects.toThrow('changed the page')
  })

  it('verifies a select rendered through the local PDF logical URL', async () => {
    const { service, runtime } = await testService()
    const project = await mkdtemp(join(tmpdir(), 'sidekick-browser-pdf-select-'))
    roots.push(project)
    const pdfPath = join(project, 'form.pdf')
    await writeFile(pdfPath, '%PDF-1.7\n%%EOF\n')
    const opened = await service.open({
      runId: 'pdf-select',
      url: pathToFileURL(pdfPath).href,
      allowedFileRoots: [project]
    })

    expect(opened.tab.url).toBe(pathToFileURL(await realpath(pdfPath)).href)
    expect(runtime.surfaces[0].url).toMatch(/^sidekick-pdf:\/\/viewer\//)
    await expect(
      service.select({
        sessionId: opened.sessionId,
        target: { role: 'combobox', name: 'Language' },
        values: ['Spanish']
      })
    ).resolves.toMatchObject({ action: 'select' })
    expect(runtime.surfaces[0].formControls.get(10)?.selectedValues).toEqual(['es'])
  })

  it('never inserts text after click or clear navigation and focus theft', async () => {
    const navigation = await testService()
    const navigationOpened = await navigation.service.open({
      runId: 'type-click-navigation',
      url: 'https://example.com/'
    })
    const navigationSurface = navigation.runtime.surfaces[0]
    navigationSurface.navigateOnClickBackendNodeId = 11
    await expect(
      navigation.service.type({
        sessionId: navigationOpened.sessionId,
        target: { role: 'textbox', name: 'Email' },
        text: 'must-not-leak'
      })
    ).rejects.toThrow('page changed before text entry')
    expect(navigationSurface.insertedText).toBe('')
    expect(navigationSurface.formControls.get(14)?.value).toBe('')

    const focus = await testService()
    const focusOpened = await focus.service.open({
      runId: 'form-focus-theft',
      url: 'https://example.com/'
    })
    const focusSurface = focus.runtime.surfaces[0]
    focusSurface.stealFocusOnClickBackendNodeId = 11
    const result = await focus.service.fillForm({
      sessionId: focusOpened.sessionId,
      fields: [
        {
          kind: 'textbox',
          target: { role: 'textbox', name: 'Email' },
          value: 'must-not-leak'
        }
      ]
    })
    expect(result).toMatchObject({
      completed: false,
      fields: [{ status: 'failed' }]
    })
    expect(focusSurface.insertedText).toBe('')
    expect(focusSurface.formControls.get(14)?.value).toBe('')
    expect(JSON.stringify(result)).not.toContain('must-not-leak')

    const clearNavigation = await testService()
    const clearNavigationOpened = await clearNavigation.service.open({
      runId: 'type-clear-navigation',
      url: 'https://example.com/'
    })
    const clearNavigationSurface = clearNavigation.runtime.surfaces[0]
    clearNavigationSurface.navigateOnBackspace = true
    await expect(
      clearNavigation.service.type({
        sessionId: clearNavigationOpened.sessionId,
        target: { role: 'textbox', name: 'Email' },
        text: 'must-not-leak'
      })
    ).rejects.toThrow('page changed before text entry')
    expect(clearNavigationSurface.insertedText).toBe('')
    expect(clearNavigationSurface.formControls.get(14)?.value).toBe('')

    const clearFocus = await testService()
    const clearFocusOpened = await clearFocus.service.open({
      runId: 'form-clear-focus-theft',
      url: 'https://example.com/'
    })
    const clearFocusSurface = clearFocus.runtime.surfaces[0]
    clearFocusSurface.stealFocusOnBackspace = true
    const clearFocusResult = await clearFocus.service.fillForm({
      sessionId: clearFocusOpened.sessionId,
      fields: [
        {
          kind: 'textbox',
          target: { role: 'textbox', name: 'Email' },
          value: 'must-not-leak'
        }
      ]
    })
    expect(clearFocusResult).toMatchObject({
      completed: false,
      fields: [{ status: 'failed' }]
    })
    expect(clearFocusSurface.insertedText).toBe('')
    expect(clearFocusSurface.formControls.get(14)?.value).toBe('')
    expect(JSON.stringify(clearFocusResult)).not.toContain('must-not-leak')
  })

  it('fills and verifies mixed standard controls with one final observation and no value echo', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'form-batch', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    const semanticCallsBefore = surface.commands.filter(
      ({ method }) => method === 'Accessibility.getFullAXTree'
    ).length
    surface.emitConsole({ level: 'info', message: 'Stored private@example.com' })
    surface.emitFailure({
      url: 'https://example.com/autosave?email=private%40example.com',
      errorText: 'Rejected private@example.com'
    })

    const result = await service.fillForm({
      sessionId: opened.sessionId,
      fields: [
        {
          kind: 'textbox',
          target: { ref: observedRef(opened, 'Email') },
          value: 'private@example.com'
        },
        {
          kind: 'select',
          target: { ref: observedRef(opened, 'Language') },
          values: ['Spanish']
        },
        {
          kind: 'checkbox',
          target: { ref: observedRef(opened, 'Subscribe') },
          checked: true
        },
        { kind: 'radio', target: { ref: observedRef(opened, 'Plan A') }, checked: true }
      ]
    })

    expect(result).toMatchObject({
      action: 'fill_form',
      completed: true,
      stopReason: 'completed',
      attemptedFields: 4,
      filledFields: 4,
      fields: [
        { index: 0, kind: 'textbox', status: 'filled', verification: { passed: true } },
        {
          index: 1,
          kind: 'select',
          status: 'filled',
          verification: { passed: true, selectedCount: 1 }
        },
        { index: 2, kind: 'checkbox', status: 'filled', verification: { passed: true } },
        { index: 3, kind: 'radio', status: 'filled', verification: { passed: true } }
      ]
    })
    expect(surface.formControls.get(11)?.value).toBe('private@example.com')
    expect(surface.formControls.get(10)?.selectedValues).toEqual(['es'])
    expect(surface.formControls.get(12)?.checked).toBe(true)
    expect(surface.formControls.get(13)?.checked).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    expect(JSON.stringify(result)).not.toContain('private%40example.com')
    expect(JSON.stringify(result)).not.toContain('Spanish')
    expect(result.observation.screenshot).toBeUndefined()
    expect(result.observation.semanticSnapshot).toContain('value=[redacted]')
    expect(result.observation.semanticSnapshot).toContain('checked=[redacted]')
    expect(
      surface.commands.filter(({ method }) => method === 'Accessibility.getFullAXTree')
    ).toHaveLength(semanticCallsBefore + 1)
  })

  it('continues independent fields after one field fails verification', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'form-failure', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.ignoreTextInput = true

    const result = await service.fillForm({
      sessionId: opened.sessionId,
      fields: [
        { kind: 'textbox', target: { ref: observedRef(opened, 'Email') }, value: 'not-applied' },
        { kind: 'checkbox', target: { ref: observedRef(opened, 'Subscribe') }, checked: true }
      ]
    })

    expect(result).toMatchObject({
      completed: false,
      stopReason: 'field_failed',
      attemptedFields: 2,
      filledFields: 1,
      fields: [
        {
          index: 0,
          status: 'failed',
          error: { code: 'verification_failed' },
          verification: { passed: false }
        },
        { index: 1, kind: 'checkbox', status: 'filled', verification: { passed: true } }
      ]
    })
    expect(surface.formControls.get(12)?.checked).toBe(true)
    expect(JSON.stringify(result)).not.toContain('not-applied')
  })

  it('stops safely when a field action navigates and does not run the remaining batch', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'form-navigation', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    surface.navigateAfterTextInput = true

    const result = await service.fillForm({
      sessionId: opened.sessionId,
      fields: [
        { kind: 'textbox', target: { ref: observedRef(opened, 'Email') }, value: 'navigate' },
        { kind: 'checkbox', target: { ref: observedRef(opened, 'Subscribe') }, checked: true }
      ]
    })

    expect(result).toMatchObject({
      completed: false,
      stopReason: 'page_changed',
      attemptedFields: 1,
      fields: [
        { index: 0, status: 'failed', error: { code: 'page_changed' } },
        { index: 1, status: 'skipped' }
      ],
      observation: { tab: { url: 'https://example.com/after-input' } }
    })
    expect(surface.formControls.get(12)?.checked).toBe(false)
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

  it('retries only transient offscreen viewport capture failures', async () => {
    const { service, runtime } = await testService()
    const opened = await service.open({ runId: 'capture-retry', url: 'https://example.com/' })
    const surface = runtime.surfaces[0]
    const attemptsBefore = surface.captureAttempts
    surface.captureFailures = 2

    await expect(service.observe(opened.sessionId)).resolves.toMatchObject({
      screenshot: { kind: 'viewport' }
    })
    expect(surface.captureAttempts - attemptsBefore).toBe(3)

    const nonTransientAttempts = surface.captureAttempts
    surface.captureFailures = 1
    surface.captureErrorMessage = 'EmbeddingTokenChanged'
    await expect(service.observe(opened.sessionId)).rejects.toThrow('EmbeddingTokenChanged')
    expect(surface.captureAttempts - nonTransientAttempts).toBe(1)

    const abortAttempts = surface.captureAttempts
    surface.captureFailures = 3
    surface.captureErrorMessage = 'UnknownVizError'
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 10)
    try {
      await expect(
        service.observe(opened.sessionId, {}, { signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(abortTimer)
    }
    expect(surface.captureAttempts - abortAttempts).toBe(1)

    const deadlineAttempts = surface.captureAttempts
    surface.captureFailures = 3
    await expect(service.observe(opened.sessionId, {}, { timeoutMs: 10 })).rejects.toMatchObject({
      name: 'TimeoutError'
    })
    expect(surface.captureAttempts - deadlineAttempts).toBe(1)
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
