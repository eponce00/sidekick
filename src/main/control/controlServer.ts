import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  CONTROL_MAX_MESSAGE_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  JSON_RPC_ERROR_NUMBERS,
  type ControlErrorCode,
  type ControlMethod,
  type ControlMethods
} from '../../shared/controlProtocol'

export type ControlHandlers = {
  [M in Exclude<ControlMethod, 'session.hello'>]: (
    params: ControlMethods[M]['params']
  ) => Promise<ControlMethods[M]['result']>
}

export interface ControlServerOptions {
  endpoint: string
  token: string
  appVersion: string
  handlers: ControlHandlers
  platform?: NodeJS.Platform
  authTimeoutMs?: number
  maxConnections?: number
}

type RequestId = number | string | null

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Constant-time comparison that does not reveal the token's length either. */
export function tokensMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false
  return timingSafeEqual(digest(expected), digest(presented))
}

function isRequestId(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'
}

/**
 * Serves the control protocol on a local endpoint. Every connection authenticates with
 * `session.hello` before anything else runs; a failed or missing hello closes it.
 */
export class ControlServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: ControlServerOptions) {}

  async start(): Promise<void> {
    const platform = this.options.platform ?? process.platform
    if (platform !== 'win32') rmSync(this.options.endpoint, { force: true })
    const server = createServer((socket) => this.accept(socket))
    server.maxConnections = this.options.maxConnections ?? 16
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (platform !== 'win32') chmodSync(this.options.endpoint, 0o600)
    server.on('error', (error) => console.error('[Control] Endpoint error:', error.message))
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if ((this.options.platform ?? process.platform) !== 'win32') {
      rmSync(this.options.endpoint, { force: true })
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let authenticated = false
    let buffered = ''
    let queue = Promise.resolve()
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.destroy()
    }, this.options.authTimeoutMs ?? 5_000)
    socket.on('close', () => {
      clearTimeout(authTimer)
      this.sockets.delete(socket)
    })
    socket.on('error', () => socket.destroy())

    const send = (message: unknown): void => {
      if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(message)}\n`)
    }
    const fail = (id: RequestId, code: ControlErrorCode, message: string, close = false): void => {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERROR_NUMBERS[code], message, data: { code } }
      })
      if (close) socket.end()
    }

    const handleLine = async (line: string): Promise<void> => {
      let request: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
        request = parsed as Record<string, unknown>
      } catch {
        fail(null, 'usage', 'Requests must be JSON-RPC objects.', !authenticated)
        return
      }
      const id = isRequestId(request.id) ? request.id : null
      const params =
        request.params === undefined
          ? {}
          : request.params && typeof request.params === 'object' && !Array.isArray(request.params)
            ? (request.params as Record<string, unknown>)
            : null
      if (
        request.jsonrpc !== '2.0' ||
        id === null ||
        typeof request.method !== 'string' ||
        !params
      ) {
        fail(
          id,
          'usage',
          'Requests must be JSON-RPC 2.0 with an id, a method, and object params.',
          !authenticated
        )
        return
      }

      if (!authenticated) {
        if (request.method !== 'session.hello' || !tokensMatch(this.options.token, params.token)) {
          fail(
            id,
            'unauthorized',
            'Authenticate with session.hello and the endpoint token first.',
            true
          )
          return
        }
        if (params.protocol !== CONTROL_PROTOCOL_VERSION) {
          fail(
            id,
            'protocol-mismatch',
            `SideKick speaks control protocol ${CONTROL_PROTOCOL_VERSION}.`,
            true
          )
          return
        }
        authenticated = true
        clearTimeout(authTimer)
        send({
          jsonrpc: '2.0',
          id,
          result: { protocol: CONTROL_PROTOCOL_VERSION, appVersion: this.options.appVersion }
        })
        return
      }

      const method = request.method as Exclude<ControlMethod, 'session.hello'>
      const handler = Object.hasOwn(this.options.handlers, method)
        ? (this.options.handlers[method] as (params: unknown) => Promise<unknown>)
        : undefined
      if (!handler) {
        fail(id, 'usage', 'Unknown method.')
        return
      }
      try {
        send({ jsonrpc: '2.0', id, result: await handler(params) })
      } catch (error) {
        if (error instanceof ControlError) {
          fail(id, error.code, error.message)
        } else {
          // Internal errors can carry paths or native details; keep them in the app's log.
          console.error('[Control] Request failed:', error)
          fail(id, 'internal', 'SideKick could not complete the request.')
        }
      }
    }

    socket.on('data', (chunk: string) => {
      if (socket.writableEnded) return
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (Buffer.byteLength(line) > CONTROL_MAX_MESSAGE_BYTES) {
          fail(null, 'usage', 'Request is too large.', true)
          buffered = ''
          return
        }
        // Requests on one connection run in order so a reply never overtakes an earlier one.
        if (line) queue = queue.then(() => (socket.writableEnded ? undefined : handleLine(line)))
        newline = buffered.indexOf('\n')
      }
      if (Buffer.byteLength(buffered) > CONTROL_MAX_MESSAGE_BYTES) {
        buffered = ''
        fail(null, 'usage', 'Request is too large.', true)
      }
    })
  }
}
