import type {
  CompanionCallName,
  CompanionCalls,
  CompanionEvent,
  CompanionReply
} from '../../../shared/companion'
import {
  deriveSessionKeys,
  equalBytes,
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

const STORAGE_KEY = 'sidekick.companion.device'

export interface StoredDevice {
  deviceId: string
  deviceSecret: string
  name: string
  pairedAt: number
}

/** Why pairing stopped, in words the phone shows. */
export class CompanionPairingError extends Error {
  constructor(
    readonly reason: 'denied' | 'expired' | 'unreachable' | 'failed',
    message: string
  ) {
    super(message)
  }
}

/** The connection is gone and needs this phone paired again. */
export class CompanionForgottenError extends Error {}

export function storedDevice(): StoredDevice | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as StoredDevice | null
    return value && typeof value.deviceId === 'string' && typeof value.deviceSecret === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

export function forgetDevice(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Nothing to forget. */
  }
}

/** A short name for this phone and browser, shown on the computer when it asks. */
export function deviceName(userAgent = navigator.userAgent): string {
  const platform = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? /Mobile/.test(userAgent)
          ? 'Android phone'
          : 'Android tablet'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Mac OS X/.test(userAgent)
            ? 'Mac'
            : 'Device'
  const browser = /EdgA?\//.test(userAgent)
    ? 'Edge'
    : /SamsungBrowser/.test(userAgent)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(userAgent)
        ? 'Firefox'
        : /CriOS|Chrome/.test(userAgent)
          ? 'Chrome'
          : /Safari/.test(userAgent)
            ? 'Safari'
            : 'Browser'
  return `${platform} · ${browser}`
}

/** Reads the one-time pairing secret from the URL fragment, then removes it from the address. */
export function takePairingSecret(): Uint8Array | null {
  const match = /(?:^#|&)p=([A-Za-z0-9_-]{22})(?:&|$)/.exec(location.hash)
  if (!match) return null
  history.replaceState(null, '', location.pathname + location.search)
  try {
    return fromBase64Url(match[1], 16)
  } catch {
    return null
  }
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal
  })
}

/** Pairs this phone: registers a new device key and waits for the user's answer on the computer. */
export async function pair(secret: Uint8Array, name = deviceName()): Promise<StoredDevice> {
  const { deviceId, deviceSecret } = newDeviceCredentials()
  const device: StoredDevice = {
    deviceId,
    deviceSecret: toBase64Url(deviceSecret),
    name,
    pairedAt: Date.now()
  }
  let response: Response
  try {
    response = await post('/api/pair', {
      box: sealWithPairingSecret(secret, 'request', {
        deviceId,
        deviceSecret: device.deviceSecret,
        name
      })
    })
  } catch {
    throw new CompanionPairingError('unreachable', 'This phone could not reach the computer.')
  }
  const body = (await response.json().catch(() => ({}))) as { box?: unknown; error?: string }
  if (response.status === 403)
    throw new CompanionPairingError('denied', 'The computer did not allow this phone.')
  if (response.status === 410 || response.status === 408)
    throw new CompanionPairingError(
      'expired',
      'This code was already used or has expired. Show a new code on the computer and scan it again.'
    )
  if (!response.ok || !body.box)
    throw new CompanionPairingError('failed', 'Pairing did not work. Scan a new code.')
  // The reply is sealed with the same secret, so it can only come from the computer that showed it.
  const reply = openWithPairingSecret(secret, 'reply', body.box) as { approved?: boolean }
  if (reply.approved !== true)
    throw new CompanionPairingError('denied', 'The computer did not allow this phone.')
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device))
  return device
}

interface Session {
  id: string
  keys: SessionKeys
  counter: number
}

/** A paired phone's encrypted connection to SideKick. */
export class CompanionClient {
  private session: Session | null = null
  private connecting: Promise<Session> | null = null
  private nextRequestId = 1
  private events: EventSource | null = null
  private lastEventCounter = 0
  private stopped = false
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly device: StoredDevice) {}

  private async handshake(): Promise<Session> {
    const ephemeral = newEphemeralKey()
    const clientRandom = randomBytes(16)
    const response = await post('/api/session', {
      deviceId: this.device.deviceId,
      e: toBase64Url(ephemeral.publicKey),
      r: toBase64Url(clientRandom)
    })
    if (response.status === 401) throw new CompanionForgottenError('This phone is not paired.')
    if (!response.ok) throw new Error('The computer did not answer.')
    const hello = (await response.json()) as ServerHello
    const serverPublic = fromBase64Url(hello.e, 32)
    const keys = deriveSessionKeys({
      deviceId: this.device.deviceId,
      deviceSecret: fromBase64Url(this.device.deviceSecret, 32),
      ownSecret: ephemeral.secret,
      peerPublic: serverPublic,
      clientPublic: ephemeral.publicKey,
      serverPublic,
      clientRandom,
      serverRandom: fromBase64Url(hello.r, 16),
      sessionId: hello.sessionId
    })
    // Without the device secret the proof cannot match, so another machine cannot pose as SideKick.
    if (!equalBytes(fromBase64Url(serverProof(keys)), fromBase64Url(hello.proof)))
      throw new Error('The computer could not prove it is the one this phone paired with.')
    return { id: hello.sessionId, keys, counter: 0 }
  }

  private async connected(): Promise<Session> {
    if (this.session) return this.session
    this.connecting ??= this.handshake().finally(() => {
      this.connecting = null
    })
    this.session = await this.connecting
    return this.session
  }

  async call<Name extends CompanionCallName>(
    call: Name,
    input: CompanionCalls[Name]['input']
  ): Promise<CompanionCalls[Name]['output']> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.connected()
      const counter = ++session.counter
      const id = this.nextRequestId++
      const response = await post('/api/rpc', {
        s: session.id,
        m: sealMessage(session.keys.request, counter, session.id, { id, call, input })
      })
      // The computer restarted or dropped the session: start a new one once.
      if (response.status === 401 && attempt === 0) {
        if (this.session === session) this.session = null
        continue
      }
      if (!response.ok) throw new Error('The computer did not answer.')
      const body = (await response.json()) as { m?: unknown }
      const reply = openMessage(session.keys.reply, session.id, body.m, counter)
        .value as CompanionReply
      if (reply.id !== id) throw new Error('The computer answered another request.')
      if (!reply.ok) throw new Error(reply.error)
      return reply.output as CompanionCalls[Name]['output']
    }
  }

  /**
   * Follows SideKick's events. `onReconnect` runs each time the stream opens again after a break,
   * since events sent meanwhile are lost and the page should load the current state.
   */
  listen(onEvent: (event: CompanionEvent) => void, onConnection: (open: boolean) => void): void {
    this.stopped = false
    const open = async (): Promise<void> => {
      if (this.stopped) return
      try {
        const session = await this.connected()
        const { ticket } = await this.call('events.ticket', {})
        const source = new EventSource(`/api/events?t=${encodeURIComponent(ticket)}`)
        this.events = source
        source.onopen = () => {
          this.retry = 0
          onConnection(true)
        }
        source.onmessage = (message) => {
          try {
            const opened = openMessage(session.keys.event, session.id, JSON.parse(message.data))
            // Events count up; an old one is a replay.
            if (opened.counter <= this.lastEventCounter) return
            this.lastEventCounter = opened.counter
            onEvent(opened.value as CompanionEvent)
          } catch {
            /* A message that does not authenticate is not SideKick's. */
          }
        }
        source.onerror = () => {
          source.close()
          if (this.events === source) this.events = null
          onConnection(false)
          schedule()
        }
      } catch (error) {
        onConnection(false)
        if (error instanceof CompanionForgottenError) throw error
        schedule()
      }
    }
    const schedule = (): void => {
      if (this.stopped || this.retryTimer) return
      const delay = Math.min(15_000, 1_000 * 2 ** this.retry++)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        // A dropped stream may mean the computer restarted, so start a fresh session.
        this.session = null
        this.lastEventCounter = 0
        void open()
      }, delay)
    }
    void open()
  }

  close(): void {
    this.stopped = true
    this.events?.close()
    this.events = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
