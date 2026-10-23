/**
 * The phone companion's encrypted channel, shared by SideKick's main process and the phone page
 * it serves. The page is served over plain HTTP on the local network, where phones offer no
 * built-in crypto, so both ends use the same audited JavaScript primitives (noble), and everything
 * after the page loads is encrypted and authenticated here.
 *
 * - Pairing: the QR code's URL fragment carries a one-time secret that never crosses the network.
 *   The phone sends its new device key sealed with a key derived from that secret, and the reply
 *   is sealed the same way, so each end knows the other read the QR code.
 * - Sessions: each connection runs an X25519 exchange keyed with the device secret, so only a
 *   paired device and this computer derive the session keys, and a later leak of the device
 *   secret does not open earlier sessions.
 * - Messages: ChaCha20-Poly1305 with per-direction keys and counter nonces; the receiver refuses
 *   a counter it has seen, so a recorded message cannot be replayed.
 */
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

export const COMPANION_PROTOCOL_VERSION = 1
export const PAIRING_SECRET_BYTES = 16
export const DEVICE_SECRET_BYTES = 32
export const DEVICE_ID_BYTES = 16
/** How long a QR code can be used. */
export const PAIRING_TTL_MS = 2 * 60 * 1_000
/** The most a phone may send in one request. */
export const COMPANION_MAX_REQUEST_BYTES = 256 * 1024
/** How far behind the newest message an out-of-order one may arrive and still be taken. */
const REPLAY_WINDOW = 64

const SALT = utf8('sidekick-companion-v1')

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Prefixes each part with its length, so no two different lists encode to the same bytes. */
function framed(...parts: Uint8Array[]): Uint8Array {
  return concat(
    ...parts.flatMap((part) => {
      const length = new Uint8Array(4)
      new DataView(length.buffer).setUint32(0, part.length)
      return [length, part]
    })
  )
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    out += B64[(chunk >> 18) & 63] + B64[(chunk >> 12) & 63]
    if (index + 1 < bytes.length) out += B64[(chunk >> 6) & 63]
    if (index + 2 < bytes.length) out += B64[chunk & 63]
  }
  return out
}

export function fromBase64Url(text: unknown, maxBytes = COMPANION_MAX_REQUEST_BYTES): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new CompanionProtocolError('Malformed data')
  if (Math.floor((text.length * 3) / 4) > maxBytes)
    throw new CompanionProtocolError('Too much data')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let index = 0
  for (const char of text) {
    value = (value << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (value >> bits) & 0xff
    }
  }
  return out
}

export class CompanionProtocolError extends Error {}

export function newPairingSecret(): Uint8Array {
  return randomBytes(PAIRING_SECRET_BYTES)
}

export function newDeviceCredentials(): { deviceId: string; deviceSecret: Uint8Array } {
  return { deviceId: toBase64Url(randomBytes(DEVICE_ID_BYTES)), deviceSecret: randomBytes(32) }
}

function pairingKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== PAIRING_SECRET_BYTES) throw new CompanionProtocolError('Bad pairing code')
  return hkdf(sha256, secret, SALT, utf8('pairing'), 32)
}

/** A pairing message, sealed with the QR code's secret. `purpose` keeps request and reply apart. */
export interface SealedBox {
  n: string
  c: string
}

export function sealWithPairingSecret(
  secret: Uint8Array,
  purpose: 'request' | 'reply',
  value: unknown
): SealedBox {
  const nonce = randomBytes(24)
  const cipher = xchacha20poly1305(pairingKey(secret), nonce, utf8(`pairing-${purpose}`))
  return {
    n: toBase64Url(nonce),
    c: toBase64Url(cipher.encrypt(utf8(JSON.stringify(value))))
  }
}

export function openWithPairingSecret(
  secret: Uint8Array,
  purpose: 'request' | 'reply',
  box: unknown
): unknown {
  const sealed = box as Partial<SealedBox> | null
  const nonce = fromBase64Url(sealed?.n, 24)
  if (nonce.length !== 24) throw new CompanionProtocolError('Malformed data')
  try {
    const cipher = xchacha20poly1305(pairingKey(secret), nonce, utf8(`pairing-${purpose}`))
    return JSON.parse(new TextDecoder().decode(cipher.decrypt(fromBase64Url(sealed?.c))))
  } catch {
    throw new CompanionProtocolError('The pairing code did not match')
  }
}

/** What the phone sends, sealed with the pairing secret, to become a paired device. */
export interface PairingRequest {
  deviceId: string
  deviceSecret: string
  name: string
}

export interface ClientHello {
  deviceId: string
  /** The phone's ephemeral X25519 public key. */
  e: string
  /** A fresh random value. */
  r: string
}

export interface ServerHello {
  sessionId: string
  e: string
  r: string
  /** Proves this computer holds the device secret. */
  proof: string
}

export interface SessionKeys {
  /** Phone to computer requests. */
  request: Uint8Array
  /** Computer to phone replies, nonce bound to the request's counter. */
  reply: Uint8Array
  /** Computer to phone events. */
  event: Uint8Array
  proof: Uint8Array
}

export function newEphemeralKey(): { secret: Uint8Array; publicKey: Uint8Array } {
  const secret = x25519.utils.randomSecretKey()
  return { secret, publicKey: x25519.getPublicKey(secret) }
}

/** The session keys both ends derive; anyone without the device secret derives different ones. */
export function deriveSessionKeys(input: {
  deviceId: string
  deviceSecret: Uint8Array
  ownSecret: Uint8Array
  peerPublic: Uint8Array
  clientPublic: Uint8Array
  serverPublic: Uint8Array
  clientRandom: Uint8Array
  serverRandom: Uint8Array
  sessionId: string
}): SessionKeys {
  if (input.deviceSecret.length !== DEVICE_SECRET_BYTES)
    throw new CompanionProtocolError('Bad device key')
  if (input.peerPublic.length !== 32) throw new CompanionProtocolError('Bad key')
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(input.ownSecret, input.peerPublic)
  } catch {
    throw new CompanionProtocolError('Bad key')
  }
  const transcript = framed(
    utf8(`v${COMPANION_PROTOCOL_VERSION}`),
    utf8(input.deviceId),
    utf8(input.sessionId),
    input.clientPublic,
    input.serverPublic,
    input.clientRandom,
    input.serverRandom
  )
  const okm = hkdf(sha256, concat(shared, input.deviceSecret), SALT, transcript, 128)
  return {
    request: okm.slice(0, 32),
    reply: okm.slice(32, 64),
    event: okm.slice(64, 96),
    proof: okm.slice(96, 128)
  }
}

export function serverProof(keys: SessionKeys): string {
  return toBase64Url(hmac(sha256, keys.proof, utf8('server')))
}

/** Compares in time that does not depend on where the inputs differ. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function counterNonce(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 1) throw new CompanionProtocolError('Bad counter')
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter))
  return nonce
}

export interface SealedMessage {
  /** The message counter, unique per key. */
  n: number
  c: string
}

export function sealMessage(
  key: Uint8Array,
  counter: number,
  sessionId: string,
  value: unknown
): SealedMessage {
  const cipher = chacha20poly1305(key, counterNonce(counter), utf8(sessionId))
  return { n: counter, c: toBase64Url(cipher.encrypt(utf8(JSON.stringify(value)))) }
}

export function openMessage(
  key: Uint8Array,
  sessionId: string,
  message: unknown,
  expectedCounter?: number
): { counter: number; value: unknown } {
  const sealed = message as Partial<SealedMessage> | null
  const counter = sealed?.n
  if (typeof counter !== 'number' || (expectedCounter !== undefined && counter !== expectedCounter))
    throw new CompanionProtocolError('Bad counter')
  try {
    const cipher = chacha20poly1305(key, counterNonce(counter), utf8(sessionId))
    const plain = cipher.decrypt(fromBase64Url(sealed?.c))
    return { counter, value: JSON.parse(new TextDecoder().decode(plain)) }
  } catch {
    throw new CompanionProtocolError('The message could not be authenticated')
  }
}

/**
 * Remembers which counters arrived, so each is taken once. Requests may arrive out of order, so
 * one up to REPLAY_WINDOW behind the newest is still taken if it is new.
 */
export class ReplayWindow {
  private newest = 0
  private seen = new Set<number>()

  accept(counter: number): boolean {
    if (!Number.isSafeInteger(counter) || counter < 1) return false
    if (counter <= this.newest - REPLAY_WINDOW || this.seen.has(counter)) return false
    this.seen.add(counter)
    if (counter > this.newest) {
      this.newest = counter
      for (const old of this.seen) if (old <= this.newest - REPLAY_WINDOW) this.seen.delete(old)
    }
    return true
  }
}

export function randomToken(bytes = 16): string {
  return toBase64Url(randomBytes(bytes))
}

export { randomBytes }
