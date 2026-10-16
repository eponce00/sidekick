/**
 * Where the control endpoint lives and how a local client finds it. Node-only and free of
 * Electron imports, because the `sidekick` CLI bundles this file too.
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlEndpointFile } from '../../shared/controlProtocol'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'

const ENDPOINT_FILE = 'endpoint.json'
// macOS limits a socket path to 104 bytes including the terminator; leave margin.
const MAX_SOCKET_PATH_BYTES = 100

export function controlDirectory(userData: string): string {
  return join(userData, 'control')
}

export function endpointFilePath(userData: string): string {
  return join(controlDirectory(userData), ENDPOINT_FILE)
}

/** Creates the private directory that holds the endpoint file and, off Windows, the socket. */
export function ensureControlDirectory(userData: string, platform = process.platform): string {
  const directory = controlDirectory(userData)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') chmodSync(directory, 0o700)
  return directory
}

/**
 * A fresh, unguessable endpoint for this launch. The name only ever appears in the private
 * endpoint file, so another account cannot create it first to collect tokens or keys.
 */
export function createEndpointName(directory: string, platform = process.platform): string {
  const nonce = randomBytes(16).toString('hex')
  if (platform === 'win32') return `\\\\.\\pipe\\sidekick-control-${nonce}`
  const socket = join(directory, `${nonce.slice(0, 12)}.sock`)
  if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return socket
  // A long home path would overflow the socket limit; the per-user temporary directory
  // is private on macOS, and mkdtemp creates it with mode 0700 everywhere.
  return join(mkdtempSync(join(tmpdir(), 'sidekick-')), 'control.sock')
}

export function createControlToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Writes the endpoint file readable only by this user, replacing any earlier one atomically. */
export function writeEndpointFile(
  userData: string,
  contents: ControlEndpointFile,
  platform = process.platform
): void {
  const directory = ensureControlDirectory(userData, platform)
  const target = join(directory, ENDPOINT_FILE)
  const temporary = join(directory, `${ENDPOINT_FILE}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, JSON.stringify(contents), { mode: 0o600, flag: 'wx' })
  try {
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Removes the endpoint file only when it still describes this launch. */
export function removeEndpointFile(userData: string, token: string): void {
  try {
    const current = parseEndpointFile(readFileSync(endpointFilePath(userData), 'utf8'))
    if (current?.token === token) rmSync(endpointFilePath(userData), { force: true })
  } catch {
    // Already gone, or replaced by a newer launch.
  }
}

export function parseEndpointFile(text: string): ControlEndpointFile | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const file = value as Record<string, unknown>
  if (
    typeof file.protocol !== 'number' ||
    typeof file.endpoint !== 'string' ||
    !file.endpoint ||
    typeof file.token !== 'string' ||
    file.token.length < 32 ||
    typeof file.pid !== 'number' ||
    typeof file.appVersion !== 'string'
  ) {
    return null
  }
  return {
    protocol: file.protocol,
    endpoint: file.endpoint,
    token: file.token,
    pid: file.pid,
    appVersion: file.appVersion
  }
}

export type EndpointLookup =
  | { status: 'found'; file: ControlEndpointFile }
  | { status: 'missing' }
  | { status: 'unsafe'; reason: string }
  | { status: 'invalid' }

/**
 * Reads the endpoint file, refusing one another account could have written or read: off
 * Windows it must be a regular file owned by this user with no group or other access.
 */
export function readEndpointFile(userData: string, platform = process.platform): EndpointLookup {
  const path = endpointFilePath(userData)
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return { status: 'missing' }
  }
  if (!stats.isFile()) return { status: 'unsafe', reason: 'the endpoint file is not a file' }
  if (platform !== 'win32') {
    if ((stats.mode & 0o077) !== 0) {
      return { status: 'unsafe', reason: 'the endpoint file is readable by other accounts' }
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      return { status: 'unsafe', reason: 'the endpoint file belongs to another account' }
    }
  }
  const file = parseEndpointFile(readFileSync(path, 'utf8'))
  return file ? { status: 'found', file } : { status: 'invalid' }
}

/** The profile directory SideKick uses, matching Electron's `userData` for this platform. */
export function defaultUserDataDirectory(
  options: { development?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const override = env['SIDEKICK_USER_DATA_DIR']
  if (override) return override
  const name = options.development ? 'sidekick-dev' : PRODUCT_IDENTITY.productName
  if (platform === 'win32')
    return join(env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), name)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  return join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), name)
}
