import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_MAX_MESSAGE_BYTES, ControlError } from '../../shared/controlProtocol'
import { createControlToken, createEndpointName, ensureControlDirectory } from './controlEndpoint'
import { ControlServer, type ControlHandlers } from './controlServer'

let userData: string
let endpoint: string
let token: string
let server: ControlServer
let handlers: { [K in keyof ControlHandlers]: ReturnType<typeof vi.fn> }

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Sends raw lines and collects replies until `count` arrive or, by default, the server closes. */
function exchange(
  socket: Socket,
  lines: string[],
  count = Number.POSITIVE_INFINITY
): Promise<{ replies: Array<Record<string, unknown>>; closed: boolean }> {
  return new Promise((resolve) => {
    const replies: Array<Record<string, unknown>> = []
    let buffered = ''
    const finish = (closed: boolean): void => resolve({ replies, closed })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        replies.push(JSON.parse(buffered.slice(0, newline)))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
      if (replies.length >= count) finish(false)
    })
    socket.on('close', () => finish(true))
    socket.on('error', () => undefined)
    for (const line of lines) socket.write(`${line}\n`)
  })
}

const request = (id: number, method: string, params: unknown = {}): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })
const hello = (presented: unknown, protocol = 1): string =>
  request(1, 'session.hello', { token: presented, protocol })

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'sidekick-control-'))
  endpoint = createEndpointName(ensureControlDirectory(userData))
  token = createControlToken()
  handlers = {
    'config.list': vi.fn(async () => ({ settings: [] })),
    'config.get': vi.fn(),
    'config.set': vi.fn(),
    'config.unset': vi.fn(),
    'config.reference': vi.fn(),
    'auth.set': vi.fn(),
    'mcp.list': vi.fn(),
    'mcp.add': vi.fn(),
    'mcp.remove': vi.fn(),
    'provider.list': vi.fn(),
    'provider.add': vi.fn(),
    'provider.set': vi.fn(),
    'provider.remove': vi.fn(),
    doctor: vi.fn()
  }
  server = new ControlServer({
    endpoint,
    token,
    appVersion: '9.9.9',
    handlers: handlers as unknown as ControlHandlers,
    authTimeoutMs: 300
  })
  await server.start()
})

afterEach(async () => {
  await server.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('control endpoint authentication', () => {
  it('answers a correct hello and then serves methods', async () => {
    const { replies } = await exchange(await open(), [hello(token), request(2, 'config.list')], 2)
    expect(replies[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocol: 1, appVersion: '9.9.9' }
    })
    expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { settings: [] } })
  })

  it.each([
    ['a wrong token', 'not-the-token'],
    ['a prefix of the token', 'PREFIX'],
    ['the token with a suffix', 'SUFFIX'],
    ['a missing token', undefined],
    ['a non-string token', 12345],
    ['an object token', { toString: 'x' }]
  ])('rejects %s and closes the connection', async (_label, presented) => {
    const value =
      presented === 'PREFIX' ? token.slice(0, -1) : presented === 'SUFFIX' ? `${token}x` : presented
    const { replies, closed } = await exchange(await open(), [
      hello(value),
      request(2, 'config.list')
    ])
    expect(replies[0]).toMatchObject({ id: 1, error: { data: { code: 'unauthorized' } } })
    expect(replies).toHaveLength(1)
    expect(closed).toBe(true)
    expect(handlers['config.list']).not.toHaveBeenCalled()
  })

  it('runs nothing before hello, even a real method', async () => {
    const { replies, closed } = await exchange(await open(), [
      request(1, 'auth.set', { providerInstanceId: 'x', secret: 'y' })
    ])
    expect(replies[0]).toMatchObject({ error: { data: { code: 'unauthorized' } } })
    expect(closed).toBe(true)
    expect(handlers['auth.set']).not.toHaveBeenCalled()
  })

  it('does not accept the token on a later request after a failed hello', async () => {
    const { replies, closed } = await exchange(await open(), [hello('wrong'), hello(token)])
    expect(replies).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('closes connections that never authenticate', async () => {
    const socket = await open()
    const { closed } = await exchange(socket, [])
    expect(closed).toBe(true)
  })

  it('refuses a different protocol version', async () => {
    const { replies, closed } = await exchange(await open(), [hello(token, 2)])
    expect(replies[0]).toMatchObject({ error: { data: { code: 'protocol-mismatch' } } })
    expect(closed).toBe(true)
  })

  it('refuses malformed and oversized requests before authentication', async () => {
    const malformed = await exchange(await open(), ['not json'])
    expect(malformed.replies[0]).toMatchObject({ id: null, error: { data: { code: 'usage' } } })
    expect(malformed.closed).toBe(true)

    const huge = `{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"${'a'.repeat(CONTROL_MAX_MESSAGE_BYTES)}"}}`
    const oversized = await exchange(await open(), [huge])
    expect(oversized.replies[0]).toMatchObject({ error: { data: { code: 'usage' } } })
    expect(oversized.closed).toBe(true)
  })

  it('does not dispatch to inherited object properties', async () => {
    const { replies } = await exchange(
      await open(),
      [
        hello(token),
        request(2, 'constructor'),
        request(3, '__proto__'),
        request(4, 'hasOwnProperty'),
        request(5, 'session.hello', { token, protocol: 1 })
      ],
      5
    )
    for (const reply of replies.slice(1)) {
      expect(reply).toMatchObject({ error: { data: { code: 'usage' } } })
    }
  })

  it('keeps internal error details out of replies', async () => {
    handlers.doctor.mockRejectedValue(new Error('EACCES C:\\secret\\path token=abc'))
    handlers['config.get'].mockRejectedValue(new ControlError('not-found', 'Unknown setting x.'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { replies } = await exchange(
      await open(),
      [hello(token), request(2, 'doctor'), request(3, 'config.get', { key: 'x' })],
      3
    )
    spy.mockRestore()
    expect(replies[1]).toMatchObject({
      error: { message: 'SideKick could not complete the request.', data: { code: 'internal' } }
    })
    expect(JSON.stringify(replies[1])).not.toContain('secret')
    expect(replies[2]).toMatchObject({
      error: { message: 'Unknown setting x.', data: { code: 'not-found' } }
    })
  })
})
