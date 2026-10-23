import Database from 'better-sqlite3'
import { request as httpRequest } from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../../bootstrap/database'
import {
  deriveSessionKeys,
  fromBase64Url,
  newDeviceCredentials,
  newEphemeralKey,
  openMessage,
  openWithPairingSecret,
  randomBytes,
  sealMessage,
  sealWithPairingSecret,
  serverProof,
  toBase64Url,
  type ServerHello,
  type SessionKeys
} from '../../../shared/companionProtocol'
import { CompanionDeviceStore } from './companionDeviceStore'
import { CompanionServer } from './companionServer'

const servers: CompanionServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

interface Reply {
  status: number
  body: string
  json: () => Record<string, unknown>
}

function send(
  port: number,
  path: string,
  options: {
    method?: string
    body?: unknown
    rawBody?: string
    headers?: Record<string, string>
  } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body))
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? (options.body === undefined && !options.rawBody ? 'GET' : 'POST'),
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers
        }
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: text, json: () => JSON.parse(text) })
        )
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

async function setup(
  options: {
    approve?: (request: { name: string }) => Promise<boolean>
    peerAllowed?: boolean
    now?: () => number
  } = {}
) {
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const devices = new CompanionDeviceStore(db, {
    isAvailable: () => false,
    encrypt: () => new Uint8Array(),
    decrypt: () => ''
  })
  const handle = vi.fn(async (call: string, input: unknown) => ({ call, input }))
  const approve = vi.fn(options.approve ?? (async () => true))
  const server = new CompanionServer({
    devices,
    approve,
    handle,
    staticFile: async (path) =>
      path === '/' ? { body: Buffer.from('<html>page</html>'), type: 'text/html' } : null,
    contentSecurityPolicy: "default-src 'none'",
    onChange: () => undefined,
    isAllowedPeer: () => options.peerAllowed ?? true,
    ...(options.now ? { now: options.now } : {})
  })
  servers.push(server)
  const { port } = await server.start('127.0.0.1', 0)
  return { server, port, devices, handle, approve, db }
}

function secretFrom(url: string): Uint8Array {
  return fromBase64Url(/#p=(.+)$/.exec(url)![1], 16)
}

async function pair(port: number, secret: Uint8Array, name = 'Test phone') {
  const { deviceId, deviceSecret } = newDeviceCredentials()
  const reply = await send(port, '/api/pair', {
    body: {
      box: sealWithPairingSecret(secret, 'request', {
        deviceId,
        deviceSecret: toBase64Url(deviceSecret),
        name
      })
    }
  })
  return { reply, deviceId, deviceSecret }
}

async function handshake(port: number, deviceId: string, deviceSecret: Uint8Array) {
  const ephemeral = newEphemeralKey()
  const clientRandom = randomBytes(16)
  const reply = await send(port, '/api/session', {
    body: { deviceId, e: toBase64Url(ephemeral.publicKey), r: toBase64Url(clientRandom) }
  })
  if (reply.status !== 200) return { reply, keys: null, sessionId: '' }
  const hello = reply.json() as unknown as ServerHello
  const serverPublic = fromBase64Url(hello.e, 32)
  const keys = deriveSessionKeys({
    deviceId,
    deviceSecret,
    ownSecret: ephemeral.secret,
    peerPublic: serverPublic,
    clientPublic: ephemeral.publicKey,
    serverPublic,
    clientRandom,
    serverRandom: fromBase64Url(hello.r, 16),
    sessionId: hello.sessionId
  })
  return { reply, keys, sessionId: hello.sessionId, proof: hello.proof }
}

async function call(
  port: number,
  session: { keys: SessionKeys; sessionId: string },
  counter: number,
  request: unknown
) {
  const sealed = sealMessage(session.keys.request, counter, session.sessionId, request)
  const reply = await send(port, '/api/rpc', { body: { s: session.sessionId, m: sealed } })
  return { reply, sealed }
}

async function paired() {
  const context = await setup()
  const secret = secretFrom(context.server.newPairing()!.url)
  const { reply, deviceId, deviceSecret } = await pair(context.port, secret)
  expect(reply.status).toBe(200)
  const session = await handshake(context.port, deviceId, deviceSecret)
  return {
    ...context,
    deviceId,
    deviceSecret,
    session: session as typeof session & { keys: SessionKeys }
  }
}

describe('CompanionServer', () => {
  it('pairs a phone the user allows and carries encrypted calls bound to their request', async () => {
    const { port, server, approve, handle, devices } = await setup()
    const info = server.newPairing()!
    expect(info.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#p=[A-Za-z0-9_-]{22}$`))
    const secret = secretFrom(info.url)
    const { reply, deviceId, deviceSecret } = await pair(port, secret, 'My\u0007 <phone>')
    expect(reply.status).toBe(200)
    expect(openWithPairingSecret(secret, 'reply', reply.json().box)).toEqual({ approved: true })
    expect(approve).toHaveBeenCalledWith(
      { name: 'My phone', address: '127.0.0.1' },
      expect.any(AbortSignal)
    )
    expect(devices.list()).toEqual([expect.objectContaining({ id: deviceId, name: 'My phone' })])
    // A new code replaces the used one.
    expect(server.pairingInfo()?.url).not.toBe(info.url)

    const session = await handshake(port, deviceId, deviceSecret)
    expect(session.reply.status).toBe(200)
    expect(session.proof).toBe(serverProof(session.keys!))
    const { reply: rpc } = await call(port, session as never, 1, {
      id: 9,
      call: 'chats.list',
      input: {}
    })
    expect(rpc.status).toBe(200)
    const opened = openMessage(session.keys!.reply, session.sessionId, rpc.json().m, 1)
    expect(opened.value).toEqual({ id: 9, ok: true, output: { call: 'chats.list', input: {} } })
    expect(handle).toHaveBeenCalledWith('chats.list', {}, deviceId)
    // The reply's nonce is the request's counter: under any other it does not open.
    expect(() => openMessage(session.keys!.reply, session.sessionId, rpc.json().m, 2)).toThrow()
  })

  it('accepts each code once, never after it expires, and never with a forged secret', async () => {
    let now = 1_000_000
    const { port, server, devices } = await setup({ now: () => now })
    const secret = secretFrom(server.newPairing()!.url)

    // A secret that is not the QR code's opens nothing and leaves the code usable.
    const forged = await pair(port, randomBytes(16))
    expect(forged.reply.status).toBe(400)
    expect(devices.list()).toEqual([])

    expect((await pair(port, secret)).reply.status).toBe(200)
    expect((await pair(port, secret)).reply.status).toBe(410)

    const next = secretFrom(server.pairingInfo()!.url)
    now += 2 * 60 * 1_000 + 1
    expect((await pair(port, next)).reply.status).toBe(410)
    expect(devices.list()).toHaveLength(1)
  })

  it('stores nothing when the user does not allow the phone, and the code is spent', async () => {
    const { port, server, devices } = await setup({ approve: async () => false })
    const secret = secretFrom(server.newPairing()!.url)
    const first = await pair(port, secret)
    expect(first.reply.status).toBe(403)
    expect(devices.list()).toEqual([])
    expect((await handshake(port, first.deviceId, first.deviceSecret)).reply.status).toBe(401)
    expect((await pair(port, secret)).reply.status).toBe(410)
  })

  it('refuses an unknown device, and a removed one at once', async () => {
    const { port, server, devices, deviceId, session } = await paired()
    expect(
      (await handshake(port, newDeviceCredentials().deviceId, randomBytes(32))).reply.status
    ).toBe(401)
    devices.remove(deviceId)
    server.disconnect(deviceId)
    const { reply } = await call(port, session, 1, { id: 1, call: 'chats.list', input: {} })
    expect(reply.status).toBe(401)
  })

  it('gives a device that does not hold its secret nothing it can use', async () => {
    const { port, deviceId } = await paired()
    // The device ID crosses the network in the clear; without the secret its keys differ.
    const impostor = await handshake(port, deviceId, randomBytes(32))
    expect(impostor.reply.status).toBe(200)
    expect(impostor.proof).not.toBe(serverProof(impostor.keys!))
    const { reply } = await call(port, impostor as never, 1, {
      id: 1,
      call: 'chats.list',
      input: {}
    })
    expect(reply.status).toBe(400)
  })

  it('refuses tampered and replayed messages', async () => {
    const { port, session, handle } = await paired()
    const first = await call(port, session, 5, { id: 1, call: 'chats.list', input: {} })
    expect(first.reply.status).toBe(200)
    const replay = await send(port, '/api/rpc', { body: { s: session.sessionId, m: first.sealed } })
    expect(replay.status).toBe(400)
    const tampered = { ...first.sealed, n: 6 }
    expect(
      (await send(port, '/api/rpc', { body: { s: session.sessionId, m: tampered } })).status
    ).toBe(400)
    // Out of order but new is fine.
    expect(
      (await call(port, session, 3, { id: 2, call: 'chats.list', input: {} })).reply.status
    ).toBe(200)
    expect(handle).toHaveBeenCalledTimes(2)
  })

  it('answers an unknown call without running anything', async () => {
    const { port, session, handle } = await paired()
    const { reply } = await call(port, session, 1, { id: 4, call: 'settings.write', input: {} })
    expect(openMessage(session.keys.reply, session.sessionId, reply.json().m, 1).value).toEqual({
      id: 4,
      ok: false,
      error: 'Unknown request'
    })
    expect(handle).not.toHaveBeenCalled()
  })

  it('refuses another host name, another origin, and peers outside the local network', async () => {
    const { port } = await setup()
    // A page elsewhere that points its own name at this address sends its own Host.
    expect((await send(port, '/', { headers: { Host: `attacker.example:${port}` } })).status).toBe(
      421
    )
    expect((await send(port, '/')).status).toBe(200)
    expect(
      (
        await send(port, '/api/session', {
          body: {},
          headers: { Origin: 'http://attacker.example' }
        })
      ).status
    ).toBe(403)
    const outside = await setup({ peerAllowed: false })
    expect((await send(outside.port, '/')).status).toBe(403)
  })

  it('refuses bodies that are too large or not JSON', async () => {
    const { port } = await setup()
    expect((await send(port, '/api/session', { rawBody: 'x'.repeat(300 * 1024) })).status).toBe(413)
    expect(
      (
        await send(port, '/api/session', {
          rawBody: '{}',
          headers: { 'Content-Type': 'text/plain' }
        })
      ).status
    ).toBe(415)
  })

  it('opens the event stream once per ticket and seals each event with a rising counter', async () => {
    const { port, server, session } = await paired()
    const ticketReply = await call(port, session, 1, { id: 1, call: 'events.ticket', input: {} })
    const ticket = (
      openMessage(session.keys.reply, session.sessionId, ticketReply.reply.json().m, 1).value as {
        output: { ticket: string }
      }
    ).output.ticket
    const received: string[] = []
    const stream = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `/api/events?t=${ticket}`,
          headers: { Host: `127.0.0.1:${port}` }
        },
        resolve
      )
      request.on('error', reject)
      request.end()
    })
    expect(stream.statusCode).toBe(200)
    stream.on('data', (chunk) => received.push(String(chunk)))
    await vi.waitFor(() => expect(server.connectedDeviceIds().size).toBe(1))
    server.broadcast({ type: 'chats.changed' })
    server.broadcast({ type: 'messages.changed', conversationId: 'c1' })
    await vi.waitFor(() => expect(received.join('')).toMatch(/data: .*\n\n.*data: /s))
    const events = received
      .join('')
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => openMessage(session.keys.event, session.sessionId, JSON.parse(line.slice(6))))
    expect(events).toEqual([
      { counter: 1, value: { type: 'chats.changed' } },
      { counter: 2, value: { type: 'messages.changed', conversationId: 'c1' } }
    ])
    stream.destroy()
    expect((await send(port, `/api/events?t=${ticket}`)).status).toBe(401)
  })
})
