import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import {
  COMPANION_CALL_NAMES,
  type CompanionCallName,
  type CompanionEvent,
  type CompanionReply,
  type CompanionRequest
} from '../../../shared/companion'
import {
  COMPANION_MAX_REQUEST_BYTES,
  CompanionProtocolError,
  PAIRING_TTL_MS,
  ReplayWindow,
  deriveSessionKeys,
  fromBase64Url,
  newEphemeralKey,
  newPairingSecret,
  openMessage,
  openWithPairingSecret,
  randomBytes,
  randomToken,
  sealMessage,
  sealWithPairingSecret,
  serverProof,
  toBase64Url,
  type ServerHello,
  type SessionKeys
} from '../../../shared/companionProtocol'
import type { CompanionDeviceStore } from './companionDeviceStore'
import {
  hostMatches,
  isLocalNetworkAddress,
  normalizedAddress,
  originMatches
} from './companionNetwork'

/** A file the phone page is made of. */
export interface CompanionStaticFile {
  body: Buffer
  type: string
}

export interface CompanionServerOptions {
  devices: CompanionDeviceStore
  /** Asks the user on this computer whether a phone may connect. */
  approve: (request: { name: string; address: string }, signal: AbortSignal) => Promise<boolean>
  /** Runs one call from a paired phone. */
  handle: (call: CompanionCallName, input: unknown, deviceId: string) => Promise<unknown>
  /** The phone page's files, by URL path and query; null when there is no such file. */
  staticFile: (path: string, search: string) => Promise<CompanionStaticFile | null>
  /** The page's Content-Security-Policy. */
  contentSecurityPolicy: string
  onChange: () => void
  /** Which peers may connect; the local network unless a test says otherwise. */
  isAllowedPeer?: (address: string) => boolean
  now?: () => number
}

interface Pairing {
  secret: Uint8Array
  expiresAt: number
  /** A phone used the code; it cannot be used again. */
  used: boolean
}

interface Session {
  id: string
  deviceId: string
  keys: SessionKeys
  replay: ReplayWindow
  eventCounter: number
  address: string
  lastUsedAt: number
  /** The phone proved it holds the device secret by sending a message that authenticated. */
  proven: boolean
}

interface EventStream {
  session: Session
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
}

/** Sessions kept at once; the oldest goes first. */
const MAX_SESSIONS = 32
const MAX_SESSIONS_PER_DEVICE = 4
const SESSION_IDLE_MS = 12 * 60 * 60 * 1_000
const TICKET_TTL_MS = 30_000
const HEARTBEAT_MS = 20_000
/** Requests a peer may make to pair or start a session, per minute. */
const UNAUTHENTICATED_PER_MINUTE = 20

class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly now: () => number
  ) {}

  allow(key: string): boolean {
    const since = this.now() - 60_000
    const recent = (this.hits.get(key) ?? []).filter((time) => time > since)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(this.now())
    this.hits.set(key, recent)
    return true
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/

/** Keeps what a phone calls itself printable and short, since the computer shows it. */
function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/[\p{C}<>]/gu, '').trim() : ''
  return (name || 'Phone').slice(0, 60)
}

/**
 * The local web server phones connect to. It serves the phone page, pairs phones with a one-time
 * QR code the user approves on this computer, and carries every call and event encrypted with the
 * keys only a paired phone and this computer hold.
 */
export class CompanionServer {
  private server: Server | null = null
  private address = ''
  private port = 0
  private pairing: Pairing | null = null
  /** Codes already used or replaced, so a phone scanning one hears that it expired. */
  private spent: Pairing[] = []
  private approving: { name: string; address: string; abort: AbortController } | null = null
  private sessions = new Map<string, Session>()
  private tickets = new Map<string, { sessionId: string; expiresAt: number }>()
  private streams = new Set<EventStream>()
  private readonly limiter: RateLimiter
  private readonly now: () => number
  private readonly isAllowedPeer: (address: string) => boolean

  constructor(private readonly options: CompanionServerOptions) {
    this.now = options.now ?? Date.now
    this.limiter = new RateLimiter(UNAUTHENTICATED_PER_MINUTE, this.now)
    this.isAllowedPeer = options.isAllowedPeer ?? isLocalNetworkAddress
  }

  get listening(): { address: string; port: number } | null {
    return this.server ? { address: this.address, port: this.port } : null
  }

  /** Listens on the local network address only; a busy preferred port gives way to a free one. */
  async start(address: string, preferredPort: number): Promise<{ address: string; port: number }> {
    if (this.server) await this.stop()
    const server = createServer((request, response) => void this.route(request, response))
    server.headersTimeout = 10_000
    server.requestTimeout = 0
    const listen = (port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off('listening', listening)
          reject(error)
        }
        const listening = (): void => {
          server.off('error', failed)
          resolve()
        }
        server.once('error', failed)
        server.once('listening', listening)
        server.listen(port, address)
      })
    try {
      await listen(preferredPort)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      await listen(0)
    }
    this.server = server
    this.address = address
    this.port = (server.address() as AddressInfo).port
    return { address: this.address, port: this.port }
  }

  async stop(): Promise<void> {
    this.approving?.abort.abort()
    this.approving = null
    this.pairing = null
    this.spent = []
    for (const stream of this.streams) this.endStream(stream)
    this.streams.clear()
    this.sessions.clear()
    this.tickets.clear()
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** A new one-time code, replacing any earlier one. */
  newPairing(): { url: string; expiresAt: number } | null {
    if (!this.server) return null
    if (this.pairing) this.spent = [this.pairing, ...this.spent].slice(0, 8)
    this.pairing = {
      secret: newPairingSecret(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      used: false
    }
    return this.pairingInfo()
  }

  pairingInfo(): { url: string; expiresAt: number } | null {
    const pairing = this.pairing
    if (!this.server || !pairing || pairing.used) return null
    return {
      url: `${this.baseUrl()}/#p=${toBase64Url(pairing.secret)}`,
      expiresAt: pairing.expiresAt
    }
  }

  awaitingApproval(): { name: string; address: string } | null {
    return this.approving ? { name: this.approving.name, address: this.approving.address } : null
  }

  baseUrl(): string {
    return `http://${this.address}:${this.port}`
  }

  /** Devices with an event stream open now. */
  connectedDeviceIds(): Set<string> {
    return new Set([...this.streams].map((stream) => stream.session.deviceId))
  }

  /** Ends every connection of a device, as when the user removes it. */
  disconnect(deviceId: string): void {
    for (const stream of [...this.streams])
      if (stream.session.deviceId === deviceId) this.endStream(stream)
    for (const [id, session] of this.sessions)
      if (session.deviceId === deviceId) this.sessions.delete(id)
    this.options.onChange()
  }

  broadcast(event: CompanionEvent): void {
    for (const stream of [...this.streams]) this.send(stream, event)
  }

  /** An event for one phone only, such as speech it asked for. */
  sendTo(deviceId: string, event: CompanionEvent): void {
    for (const stream of [...this.streams])
      if (stream.session.deviceId === deviceId) this.send(stream, event)
  }

  private send(stream: EventStream, event: CompanionEvent): void {
    const session = stream.session
    const sealed = sealMessage(session.keys.event, ++session.eventCounter, session.id, event)
    try {
      stream.response.write(`data: ${JSON.stringify(sealed)}

`)
    } catch {
      this.endStream(stream)
    }
  }

  // Requests

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const peer = normalizedAddress(request.socket.remoteAddress)
    try {
      // A request from outside the local network, or naming another host (a page elsewhere
      // rebinding its name to this address), is refused before anything else is read.
      if (!this.isAllowedPeer(peer)) throw new HttpError(403, 'not_local')
      if (!hostMatches(request.headers.host, this.address, this.port))
        throw new HttpError(421, 'wrong_host')
      const url = new URL(request.url ?? '/', this.baseUrl())
      if (url.pathname.startsWith('/api/')) {
        if (!originMatches(request.headers.origin, this.address, this.port))
          throw new HttpError(403, 'wrong_origin')
        if (request.method === 'GET' && url.pathname === '/api/events')
          return this.openEvents(url, peer, response)
        if (request.method !== 'POST') throw new HttpError(405, 'method')
        const body = await readJson(request)
        if (url.pathname === '/api/pair') return await this.pair(body, peer, response)
        if (url.pathname === '/api/session') return this.startSession(body, peer, response)
        if (url.pathname === '/api/rpc') return await this.call(body, peer, response)
        throw new HttpError(404, 'not_found')
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method')
      const file = await this.options.staticFile(url.pathname, url.search)
      if (!file) throw new HttpError(404, 'not_found')
      response.writeHead(200, {
        ...this.pageHeaders(),
        'Content-Type': file.type,
        'Content-Length': file.body.length,
        'Cache-Control': url.pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      })
      response.end(request.method === 'HEAD' ? undefined : file.body)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'failed'
      if (!(error instanceof HttpError) && !(error instanceof CompanionProtocolError))
        console.warn('[Companion] A request failed:', error)
      json(response, error instanceof CompanionProtocolError ? 400 : status, {
        error: error instanceof CompanionProtocolError ? 'bad_request' : code
      })
    }
  }

  private pageHeaders(): Record<string, string> {
    return {
      'Content-Security-Policy': this.options.contentSecurityPolicy,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    }
  }

  private async pair(body: unknown, peer: string, response: ServerResponse): Promise<void> {
    if (!this.limiter.allow(`pair:${peer}`) || !this.limiter.allow('pair'))
      throw new HttpError(429, 'slow_down')
    if (this.approving) throw new HttpError(409, 'busy')
    // Only the phone that read the QR code can seal a request one of these opens.
    const box = (body as { box?: unknown } | null)?.box
    let pairing: Pairing | null = null
    let request: Record<string, unknown> | null = null
    for (const candidate of [this.pairing, ...this.spent]) {
      if (!candidate) continue
      try {
        request = openWithPairingSecret(candidate.secret, 'request', box) as Record<string, unknown>
        pairing = candidate
        break
      } catch {
        /* Another code's. */
      }
    }
    if (!pairing) throw new HttpError(400, 'bad_request')
    if (pairing !== this.pairing || pairing.used || this.now() > pairing.expiresAt)
      throw new HttpError(410, 'code_expired')
    const deviceId = request?.deviceId
    const deviceSecret = request?.deviceSecret
    if (
      typeof deviceId !== 'string' ||
      !DEVICE_ID.test(deviceId) ||
      typeof deviceSecret !== 'string' ||
      !DEVICE_SECRET.test(deviceSecret) ||
      this.options.devices.secret(deviceId) !== null
    )
      throw new HttpError(400, 'bad_request')
    // The code works once, whatever the user answers.
    pairing.used = true
    const name = cleanName(request?.name)
    const abort = new AbortController()
    this.approving = { name, address: peer, abort }
    this.options.onChange()
    const closed = (): void => abort.abort()
    response.once('close', closed)
    let approved = false
    try {
      const timer = setTimeout(() => abort.abort(), PAIRING_TTL_MS)
      try {
        approved = await this.options.approve({ name, address: peer }, abort.signal)
      } finally {
        clearTimeout(timer)
      }
      if (approved && abort.signal.aborted) approved = false
      if (approved)
        this.options.devices.add({ id: deviceId, name, secret: deviceSecret, address: peer })
    } finally {
      response.off('close', closed)
      if (this.approving?.abort === abort) this.approving = null
      if (this.pairing === pairing) this.newPairing()
      this.options.onChange()
    }
    if (!approved) throw new HttpError(abort.signal.aborted ? 408 : 403, 'not_allowed')
    json(response, 200, { box: sealWithPairingSecret(pairing.secret, 'reply', { approved: true }) })
  }

  private startSession(body: unknown, peer: string, response: ServerResponse): void {
    if (!this.limiter.allow(`session:${peer}`)) throw new HttpError(429, 'slow_down')
    const hello = (body ?? {}) as Record<string, unknown>
    const deviceId = hello.deviceId
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId))
      throw new HttpError(400, 'bad_request')
    const secret = this.options.devices.secret(deviceId)
    if (!secret) throw new HttpError(401, 'unknown_device')
    const clientPublic = fromBase64Url(hello.e, 32)
    const clientRandom = fromBase64Url(hello.r, 16)
    if (clientPublic.length !== 32 || clientRandom.length !== 16)
      throw new HttpError(400, 'bad_request')
    const ephemeral = newEphemeralKey()
    const serverRandom = randomBytes(16)
    const sessionId = randomToken(18)
    const keys = deriveSessionKeys({
      deviceId,
      deviceSecret: fromBase64Url(secret, 32),
      ownSecret: ephemeral.secret,
      peerPublic: clientPublic,
      clientPublic,
      serverPublic: ephemeral.publicKey,
      clientRandom,
      serverRandom,
      sessionId
    })
    this.pruneSessions(deviceId)
    this.sessions.set(sessionId, {
      id: sessionId,
      deviceId,
      keys,
      replay: new ReplayWindow(),
      eventCounter: 0,
      address: peer,
      lastUsedAt: this.now(),
      proven: false
    })
    const reply: ServerHello = {
      sessionId,
      e: toBase64Url(ephemeral.publicKey),
      r: toBase64Url(serverRandom),
      proof: serverProof(keys)
    }
    json(response, 200, reply)
  }

  private pruneSessions(deviceId: string): void {
    const cutoff = this.now() - SESSION_IDLE_MS
    for (const [id, session] of this.sessions)
      if (session.lastUsedAt < cutoff) this.sessions.delete(id)
    const own = [...this.sessions.values()]
      .filter((session) => session.deviceId === deviceId)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    while (own.length >= MAX_SESSIONS_PER_DEVICE) this.dropSession(own.shift()!.id)
    const all = [...this.sessions.values()].sort(
      (left, right) => left.lastUsedAt - right.lastUsedAt
    )
    while (all.length >= MAX_SESSIONS) this.dropSession(all.shift()!.id)
  }

  private dropSession(id: string): void {
    this.sessions.delete(id)
    for (const stream of [...this.streams]) if (stream.session.id === id) this.endStream(stream)
  }

  /** The session a request names, if the device is still paired. */
  private session(id: unknown): Session {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!session || this.options.devices.secret(session.deviceId) === null) {
      if (session) this.dropSession(session.id)
      throw new HttpError(401, 'no_session')
    }
    return session
  }

  private async call(body: unknown, peer: string, response: ServerResponse): Promise<void> {
    const envelope = (body ?? {}) as { s?: unknown; m?: unknown }
    const session = this.session(envelope.s)
    const opened = openMessage(session.keys.request, session.id, envelope.m)
    if (!session.replay.accept(opened.counter)) throw new HttpError(400, 'replayed')
    const firstProof = !session.proven
    session.proven = true
    session.lastUsedAt = this.now()
    session.address = peer
    if (firstProof) this.options.devices.touch(session.deviceId, peer)
    const request = opened.value as Partial<CompanionRequest> | null
    const id = typeof request?.id === 'number' ? request.id : 0
    let reply: CompanionReply
    if (!request || !COMPANION_CALL_NAMES.includes(request.call as CompanionCallName)) {
      reply = { id, ok: false, error: 'Unknown request' }
    } else if (request.call === 'events.ticket') {
      const ticket = randomToken(24)
      this.tickets.set(ticket, { sessionId: session.id, expiresAt: this.now() + TICKET_TTL_MS })
      reply = { id, ok: true, output: { ticket } }
    } else {
      try {
        const output = await this.options.handle(
          request.call as CompanionCallName,
          request.input,
          session.deviceId
        )
        reply = { id, ok: true, output }
      } catch (error) {
        reply = {
          id,
          ok: false,
          error: error instanceof Error ? error.message : 'The request failed'
        }
      }
    }
    // The reply's nonce is the request's counter, under its own key, so it answers only that one.
    json(response, 200, { m: sealMessage(session.keys.reply, opened.counter, session.id, reply) })
  }

  private openEvents(url: URL, peer: string, response: ServerResponse): void {
    const ticketId = url.searchParams.get('t') ?? ''
    const ticket = this.tickets.get(ticketId)
    this.tickets.delete(ticketId)
    if (!ticket || ticket.expiresAt < this.now()) throw new HttpError(401, 'no_session')
    const session = this.session(ticket.sessionId)
    session.address = peer
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    })
    response.write(': connected\n\n')
    const stream: EventStream = {
      session,
      response,
      heartbeat: setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          this.endStream(stream)
        }
      }, HEARTBEAT_MS)
    }
    this.streams.add(stream)
    response.once('close', () => {
      if (this.streams.has(stream)) {
        this.endStream(stream)
        this.options.onChange()
      }
    })
    this.options.devices.touch(session.deviceId, peer)
    this.options.onChange()
  }

  private endStream(stream: EventStream): void {
    clearInterval(stream.heartbeat)
    this.streams.delete(stream)
    try {
      stream.response.end()
    } catch {
      /* Already closed. */
    }
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(text)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? ''))
    throw new HttpError(415, 'json_only')
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > COMPANION_MAX_REQUEST_BYTES) throw new HttpError(413, 'too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > COMPANION_MAX_REQUEST_BYTES) throw new HttpError(413, 'too_large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_request')
  }
}
