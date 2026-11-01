import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { join } from 'path'

// Short enough that a request never outlives what Chrome allows an extension's worker.
const HOLD_REQUEST_MS = 20_000
const CONNECTED_WITHIN_MS = HOLD_REQUEST_MS + 15_000
const OPERATION_TIMEOUT_MS = 45_000
const MAX_BODY_BYTES = 64 * 1024 * 1024
const POLL_MS = 250

/** The id Chrome gives an extension with this public key, from its base64 `key`. */
export function chromeExtensionId(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function same(a: string, b: string): boolean {
  const [first, second] = [Buffer.from(a), Buffer.from(b)]
  return first.length === second.length && timingSafeEqual(first, second)
}

interface Work {
  id: string
  op: string
  args: Record<string, unknown>
}

/**
 * The line to the extension in the user's Chrome, over this computer's loopback address. Only the
 * extension can use it: a web page can't read the secret in the extension's folder, its requests carry
 * its own origin, and a page that rebinds a name to this address is caught by the Host check.
 */
export class ChromeUseBridge {
  private server: Server | null = null
  private secret = ''
  private port = 0
  private extensionId = ''
  private bundledVersion = ''
  private starting: Promise<void> | null = null
  private newest: { instance: string; seen: number; version: string } | null = null
  private readonly queue: Work[] = []
  /** One held request for each extension worker, as each profile it is set up in has its own. */
  private readonly holding = new Map<string, (work: Work | null) => void>()
  private readonly knownInstances = new Set<string>()
  private readonly waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()
  private nextId = 0

  constructor(
    private readonly bundledFolder: () => string,
    private readonly installFolder: () => string,
    private readonly onSeen: () => void = () => undefined
  ) {}

  /** Where the extension gets loaded from: a folder of SideKick's that stays put across updates. */
  folder(): string {
    return this.installFolder()
  }

  start(): Promise<void> {
    this.starting ??= this.begin().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  private async begin(): Promise<void> {
    const folder = this.installFolder()
    await fs.mkdir(folder, { recursive: true })
    const bundled = this.bundledFolder()
    await fs.copyFile(join(bundled, 'manifest.json'), join(folder, 'manifest.json'))
    await fs.copyFile(join(bundled, 'background.js'), join(folder, 'background.js'))
    const manifest = JSON.parse(await fs.readFile(join(bundled, 'manifest.json'), 'utf8')) as {
      key: string
      version: string
    }
    this.extensionId = chromeExtensionId(manifest.key)
    this.bundledVersion = manifest.version
    this.secret = randomBytes(32).toString('hex')
    const server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    server.unref()
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
    await fs.writeFile(
      join(folder, 'pairing.json'),
      JSON.stringify({ port: this.port, token: this.secret }),
      { encoding: 'utf8', mode: 0o600 }
    )
  }

  private allowed(request: IncomingMessage): boolean {
    return (
      request.socket.remoteAddress?.endsWith('127.0.0.1') === true &&
      request.headers.host === `127.0.0.1:${this.port}` &&
      request.headers.origin === `chrome-extension://${this.extensionId}` &&
      same(request.headers.authorization ?? '', `Bearer ${this.secret}`)
    )
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !this.allowed(request)) {
      response.writeHead(403).end()
      return
    }
    if (request.url === '/next') {
      this.hold(request, response)
      return
    }
    if (request.url === '/answer') {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) request.destroy()
        else chunks.push(chunk)
      })
      request.on('end', () => {
        response.writeHead(204).end()
        this.settle(Buffer.concat(chunks).toString('utf8'))
      })
      return
    }
    response.writeHead(404).end()
  }

  private hold(request: IncomingMessage, response: ServerResponse): void {
    const instance = String(request.headers['x-sidekick-instance'] ?? '')
    const version = String(request.headers['x-sidekick-version'] ?? '')
    // A worker that has just started is the one to use, or any at all once that one has gone quiet.
    // Going by whichever asked last would flip between profiles.
    const fresh = !this.knownInstances.has(instance)
    this.knownInstances.add(instance)
    if (fresh || !this.isConnected()) {
      this.newest = { instance, seen: Date.now(), version }
      this.onSeen()
      if (version !== this.bundledVersion) this.enqueue('reload', {})
    } else if (this.newest?.instance === instance) this.newest.seen = Date.now()
    const reply = (work: Work | null): void => {
      clearTimeout(timer)
      if (this.holding.get(instance) === reply) this.holding.delete(instance)
      if (!response.writableEnded) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(work ?? {}))
      }
    }
    const timer = setTimeout(() => reply(null), HOLD_REQUEST_MS)
    timer.unref?.()
    request.on('close', () => {
      if (!response.writableEnded && !request.complete) reply(null)
    })
    const ready = this.newest?.instance === instance ? this.queue.shift() : undefined
    if (ready) return reply(ready)
    this.holding.get(instance)?.(null)
    this.holding.set(instance, reply)
  }

  private settle(body: string): void {
    let answer: { id?: string; result?: unknown; error?: string }
    try {
      answer = JSON.parse(body) as typeof answer
    } catch {
      return
    }
    const waiter = answer.id ? this.waiting.get(answer.id) : undefined
    if (!waiter || !answer.id) return
    this.waiting.delete(answer.id)
    if (answer.error) waiter.reject(new Error(answer.error))
    else waiter.resolve(answer.result)
  }

  private enqueue(op: string, args: Record<string, unknown>): string {
    const id = String(++this.nextId)
    const work = { id, op, args }
    const held = this.newest ? this.holding.get(this.newest.instance) : undefined
    if (held) held(work)
    else this.queue.push(work)
    return id
  }

  /** Whether the extension has been heard from lately, which means Chrome is open with it in. */
  isConnected(): boolean {
    return this.newest !== null && Date.now() - this.newest.seen < CONNECTED_WITHIN_MS
  }

  /** False if nothing was heard from it in that time. */
  async waitForConnection(ms: number, signal: AbortSignal): Promise<boolean> {
    await this.start()
    const deadline = Date.now() + ms
    while (!this.isConnected()) {
      if (Date.now() >= deadline || signal.aborted) return false
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    return true
  }

  send<T>(op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const id = this.enqueue(op, args)
      const finish = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        this.waiting.delete(id)
      }
      const aborted = (): void => {
        finish()
        reject(new Error('Cancelled.'))
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error('Chrome did not answer in time.'))
      }, OPERATION_TIMEOUT_MS)
      timer.unref?.()
      signal.addEventListener('abort', aborted, { once: true })
      this.waiting.set(id, {
        resolve: (value) => {
          finish()
          resolve(value as T)
        },
        reject: (error) => {
          finish()
          reject(error)
        }
      })
    })
  }

  async close(): Promise<void> {
    for (const reply of [...this.holding.values()]) reply(null)
    const server = this.server
    this.server = null
    this.starting = null
    if (server) await new Promise((resolve) => server.close(resolve))
  }
}
