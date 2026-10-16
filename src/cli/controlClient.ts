import { connect, type Socket } from 'node:net'
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  isControlErrorCode,
  type ControlEndpointFile,
  type ControlMethod,
  type ControlMethods
} from '../shared/controlProtocol'

/** One authenticated connection to the running app's control endpoint. */
export class ControlClient {
  private buffered = ''
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.receive(chunk))
    socket.on('close', () => this.rejectAll('SideKick closed the connection.'))
    socket.on('error', () => this.rejectAll('SideKick closed the connection.'))
  }

  static async connect(
    file: ControlEndpointFile,
    client: string,
    timeoutMs = 10_000
  ): Promise<ControlClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = connect(file.endpoint)
      const timer = setTimeout(() => {
        attempt.destroy()
        reject(new ControlError('not-running', 'SideKick did not answer.'))
      }, timeoutMs)
      attempt.once('connect', () => {
        clearTimeout(timer)
        resolve(attempt)
      })
      attempt.once('error', () => {
        clearTimeout(timer)
        // A stale endpoint file from a crashed launch looks the same as no app.
        reject(new ControlError('not-running', 'SideKick is not running.'))
      })
    })
    const instance = new ControlClient(socket)
    await instance.call(
      'session.hello',
      { token: file.token, protocol: CONTROL_PROTOCOL_VERSION, client },
      timeoutMs
    )
    return instance
  }

  call<M extends ControlMethod>(
    method: M,
    params: ControlMethods[M]['params'],
    timeoutMs = 30_000
  ): Promise<ControlMethods[M]['result']> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ControlError('internal', 'SideKick did not answer in time.'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as ControlMethods[M]['result'])
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close(): void {
    this.socket.end()
  }

  private receive(chunk: string): void {
    this.buffered += chunk
    let newline = this.buffered.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      this.settle(line)
      newline = this.buffered.indexOf('\n')
    }
  }

  private settle(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!waiting) {
      // An error without an id (oversized or malformed request) fails everything in flight.
      if (message.id === null && message.error) this.rejectAll(errorFrom(message.error).message)
      return
    }
    this.pending.delete(message.id as number)
    if (message.error) waiting.reject(errorFrom(message.error))
    else waiting.resolve(message.result)
  }

  private rejectAll(reason: string): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id)
      waiting.reject(new ControlError('internal', reason))
    }
  }
}

function errorFrom(value: unknown): ControlError {
  const error = value as { message?: unknown; data?: { code?: unknown } }
  const code = isControlErrorCode(error?.data?.code) ? error.data.code : 'internal'
  return new ControlError(
    code,
    typeof error?.message === 'string' ? error.message : 'SideKick refused the request.'
  )
}
