import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { readFile } from 'fs/promises'
import { fileURLToPath, pathToFileURL } from 'url'
import type { ToolDiagnostic } from '../../../shared/agentRuntime'
import { PRODUCT_IDENTITY } from '../../../shared/productIdentity'
import packageMetadata from '../../../../package.json'
import { languageIdForFile, type ResolvedLanguageServer } from './serverRegistry'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  cleanup: () => void
}
interface LspDiagnostic {
  range?: { start?: { line?: number; character?: number } }
  severity?: number
  message?: string
  source?: string
  code?: string | number
}

export class LspClient {
  private process?: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private initialized = false
  private starting?: Promise<void>
  private closing?: Promise<void>
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly diagnostics = new Map<string, ToolDiagnostic[]>()
  private readonly diagnosticsPending = new Set<string>()
  private readonly diagnosticWaiters = new Map<string, Set<() => void>>()
  private readonly opened = new Map<string, { version: number; content: string }>()

  constructor(
    private readonly workspaceRoot: string,
    readonly server: ResolvedLanguageServer
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return
    if (!this.starting) {
      this.starting = this.startProcess(signal).finally(() => {
        this.starting = undefined
      })
    }
    await this.starting
  }

  private async startProcess(signal?: AbortSignal): Promise<void> {
    const child = spawn(this.server.command, this.server.args, {
      cwd: this.workspaceRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process = child
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.consume()
    })
    child.stderr.on('data', () => undefined)
    child.on('exit', (code) =>
      this.failAll(new Error(`${this.server.name} exited with code ${code ?? 'unknown'}`))
    )
    child.on('error', (error) => this.failAll(error))
    const rootUri = pathToFileURL(this.workspaceRoot).toString()
    await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: PRODUCT_IDENTITY.productName, version: packageMetadata.version },
        rootUri,
        workspaceFolders: [
          { uri: rootUri, name: this.workspaceRoot.split(/[\\/]/).at(-1) || 'workspace' }
        ],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            definition: {},
            references: {},
            hover: {},
            documentSymbol: {},
            implementation: {}
          }
        },
        initializationOptions: this.server.initializationOptions
      },
      signal,
      12_000
    )
    this.notify('initialized', {})
    this.initialized = true
  }

  async open(filePath: string, signal?: AbortSignal): Promise<string> {
    await this.start(signal)
    const uri = pathToFileURL(filePath).toString()
    const content = await readFile(filePath, 'utf8')
    const prior = this.opened.get(uri)
    if (!prior) {
      this.opened.set(uri, { version: 1, content })
      this.diagnosticsPending.add(uri)
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageIdForFile(this.server, filePath),
          version: 1,
          text: content
        }
      })
    } else if (prior.content !== content) {
      const version = prior.version + 1
      this.opened.set(uri, { version, content })
      this.diagnosticsPending.add(uri)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      })
    }
    return uri
  }

  async requestForFile(
    method: string,
    filePath: string,
    line = 0,
    column = 0,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    const uri = await this.open(filePath, signal)
    return this.request(
      method,
      {
        textDocument: { uri },
        position: { line: Math.max(0, line), character: Math.max(0, column) },
        ...extra
      },
      signal
    )
  }

  async diagnosticsFor(filePath: string, signal?: AbortSignal): Promise<ToolDiagnostic[]> {
    const uri = await this.open(filePath, signal)
    try {
      const result = await this.request(
        'textDocument/diagnostic',
        { textDocument: { uri } },
        signal,
        2_500
      )
      const items = (result as { items?: LspDiagnostic[] } | null)?.items
      if (Array.isArray(items))
        this.diagnostics.set(
          uri,
          items.map((item) => this.mapDiagnostic(filePath, item))
        )
      if (Array.isArray(items)) this.diagnosticsPending.delete(uri)
    } catch {
      if (this.diagnosticsPending.has(uri)) await this.waitForPublishedDiagnostics(uri, 500)
    }
    if (this.diagnosticsPending.has(uri)) {
      throw new Error(`${this.server.name} did not return diagnostics for the current file version`)
    }
    return this.diagnostics.get(uri) ?? []
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal)
    return this.request('workspace/symbol', { query }, signal)
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    const child = this.process
    if (!child) return
    this.closing = this.stopProcess(child).finally(() => {
      if (this.process === child) this.process = undefined
      this.initialized = false
      this.closing = undefined
    })
    return this.closing
  }

  private async stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    await this.request('shutdown', null, undefined, 1_000).catch(() => undefined)
    if (this.process === child) this.notify('exit', null)
    if (child.exitCode !== null || child.signalCode !== null) return

    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        child.removeListener('close', done)
        child.removeListener('error', done)
        resolve()
      }
      const timeout = setTimeout(done, 3_000)
      timeout.unref()
      child.once('close', done)
      child.once('error', done)
      child.kill()
    })
  }

  private request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = 8_000
  ): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error(`${this.server.name} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      const abort = (): void => {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error(`${method} cancelled`))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timeout,
        cleanup
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    if (this.process) this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message))
    this.process?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.process?.stdin.write(body)
  }

  private consume(): void {
    while (true) {
      const marker = this.buffer.indexOf('\r\n\r\n')
      if (marker < 0) return
      const header = this.buffer.subarray(0, marker).toString()
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] || 0)
      if (!length || this.buffer.length < marker + 4 + length) return
      const body = this.buffer.subarray(marker + 4, marker + 4 + length).toString()
      this.buffer = this.buffer.subarray(marker + 4 + length)
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage)
      } catch {
        /* ignore malformed server payload */
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      pending.cleanup()
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] }
      if (params.uri && Array.isArray(params.diagnostics)) {
        const filePath = fileURLToPath(params.uri)
        this.diagnostics.set(
          params.uri,
          params.diagnostics.map((item) => this.mapDiagnostic(filePath, item))
        )
        this.diagnosticsPending.delete(params.uri)
        for (const resolve of this.diagnosticWaiters.get(params.uri) ?? []) resolve()
        this.diagnosticWaiters.delete(params.uri)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      const result =
        message.method === 'workspace/configuration'
          ? []
          : message.method === 'workspace/workspaceFolders'
            ? [
                {
                  uri: pathToFileURL(this.workspaceRoot).toString(),
                  name: this.workspaceRoot.split(/[\\/]/).at(-1)
                }
              ]
            : null
      this.send({ jsonrpc: '2.0', id: message.id, result })
    }
  }

  private mapDiagnostic(filePath: string, diagnostic: LspDiagnostic): ToolDiagnostic {
    const severity =
      diagnostic.severity === 1 ? 'error' : diagnostic.severity === 2 ? 'warning' : 'information'
    return {
      filePath,
      line: (diagnostic.range?.start?.line ?? 0) + 1,
      column: (diagnostic.range?.start?.character ?? 0) + 1,
      severity,
      message: diagnostic.message || 'Language diagnostic',
      source: diagnostic.source || this.server.id,
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code)
    }
  }

  private waitForPublishedDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timeout)
        const waiters = this.diagnosticWaiters.get(uri)
        waiters?.delete(done)
        if (waiters?.size === 0) this.diagnosticWaiters.delete(uri)
        resolve()
      }
      const timeout = setTimeout(done, timeoutMs)
      const waiters = this.diagnosticWaiters.get(uri) ?? new Set<() => void>()
      waiters.add(done)
      this.diagnosticWaiters.set(uri, waiters)
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    this.process = undefined
    this.initialized = false
  }
}
