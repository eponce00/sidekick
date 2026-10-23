import { describe, expect, it } from 'vitest'
import {
  COMPANION_MAX_REPLY_BYTES,
  ReplayWindow,
  deriveSessionKeys,
  fromBase64Url,
  newDeviceCredentials,
  newEphemeralKey,
  newPairingSecret,
  openMessage,
  openWithPairingSecret,
  randomBytes,
  sealMessage,
  sealWithPairingSecret,
  serverProof,
  toBase64Url
} from './companionProtocol'

function sessionPair(deviceSecret: Uint8Array, serverDeviceSecret = deviceSecret) {
  const client = newEphemeralKey()
  const server = newEphemeralKey()
  const common = {
    deviceId: 'device',
    clientPublic: client.publicKey,
    serverPublic: server.publicKey,
    clientRandom: randomBytes(16),
    serverRandom: randomBytes(16),
    sessionId: 'session'
  }
  return {
    client: deriveSessionKeys({
      ...common,
      deviceSecret,
      ownSecret: client.secret,
      peerPublic: server.publicKey
    }),
    server: deriveSessionKeys({
      ...common,
      deviceSecret: serverDeviceSecret,
      ownSecret: server.secret,
      peerPublic: client.publicKey
    })
  }
}

describe('companion protocol', () => {
  it('round-trips base64url and refuses malformed or oversized text', () => {
    for (const length of [0, 1, 2, 3, 16, 32, 33]) {
      const bytes = randomBytes(length)
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    }
    expect(toBase64Url(randomBytes(32))).toHaveLength(43)
    expect(() => fromBase64Url('a+b/')).toThrow()
    expect(() => fromBase64Url('abcde')).toThrow()
    expect(() => fromBase64Url(toBase64Url(randomBytes(33)), 32)).toThrow()
    expect(() => fromBase64Url(42)).toThrow()
  })

  it('opens a pairing box only with the QR code secret and for its purpose', () => {
    const secret = newPairingSecret()
    const box = sealWithPairingSecret(secret, 'request', { hello: 'phone' })
    expect(openWithPairingSecret(secret, 'request', box)).toEqual({ hello: 'phone' })
    expect(() => openWithPairingSecret(newPairingSecret(), 'request', box)).toThrow()
    // A request cannot be reflected back as the computer's reply.
    expect(() => openWithPairingSecret(secret, 'reply', box)).toThrow()
    const tampered = { ...box, c: box.c.slice(0, -2) + (box.c.endsWith('A') ? 'BA' : 'AA') }
    expect(() => openWithPairingSecret(secret, 'request', tampered)).toThrow()
  })

  it('derives the same keys at both ends only with the same device secret', () => {
    const { deviceSecret } = newDeviceCredentials()
    const same = sessionPair(deviceSecret)
    expect(same.client).toEqual(same.server)
    expect(serverProof(same.client)).toBe(serverProof(same.server))
    const other = sessionPair(deviceSecret, randomBytes(32))
    expect(serverProof(other.client)).not.toBe(serverProof(other.server))
    expect(other.client.request).not.toEqual(other.server.request)
  })

  it('authenticates each message, its counter and its session', () => {
    const { client } = sessionPair(randomBytes(32))
    const sealed = sealMessage(client.request, 7, 'session', { call: 'chats.list' })
    expect(openMessage(client.request, 'session', sealed)).toEqual({
      counter: 7,
      value: { call: 'chats.list' }
    })
    expect(() => openMessage(client.request, 'session', { ...sealed, n: 8 })).toThrow()
    expect(() => openMessage(client.request, 'other-session', sealed)).toThrow()
    expect(() => openMessage(client.reply, 'session', sealed)).toThrow()
    expect(() => openMessage(client.request, 'session', sealed, 6)).toThrow()
    expect(() => sealMessage(client.request, 0, 'session', {})).toThrow()
  })

  it('opens a large reply only when the receiver allows it', () => {
    const { client } = sessionPair(randomBytes(32))
    const big = sealMessage(client.reply, 1, 'session', { chat: 'x'.repeat(400 * 1024) })
    // A request this large is refused; a reply to the phone can carry a long chat.
    expect(() => openMessage(client.reply, 'session', big)).toThrow()
    expect(openMessage(client.reply, 'session', big, 1, COMPANION_MAX_REPLY_BYTES).value).toEqual({
      chat: 'x'.repeat(400 * 1024)
    })
  })

  it('takes each counter once, out of order within the window', () => {
    const window = new ReplayWindow()
    expect(window.accept(2)).toBe(true)
    expect(window.accept(1)).toBe(true)
    expect(window.accept(2)).toBe(false)
    expect(window.accept(100)).toBe(true)
    expect(window.accept(37)).toBe(true)
    expect(window.accept(36)).toBe(false)
    expect(window.accept(0)).toBe(false)
    expect(window.accept(1.5)).toBe(false)
  })
})
