import { BrowserWindow, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { networkInterfaces } from 'os'
import { extname, join } from 'path'
import qrcode from 'qrcode-generator'
import icon from '../../../resources/icon.png?asset'
import type { CompanionEvent, CompanionStatus } from '../../shared/companion'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import { CompanionApi, trimForPhone } from '../services/companion/companionApi'
import { CompanionDeviceStore } from '../services/companion/companionDeviceStore'
import {
  isDevelopmentPagePath,
  pickLocalNetworkAddress
} from '../services/companion/companionNetwork'
import { CompanionServer, type CompanionStaticFile } from '../services/companion/companionServer'
import { resolveConversationModel } from '../services/conversationModelStore'
import { isSecureCredentialStorageAvailable } from '../services/secureCredentialStorage'
import { showTrustedDialog } from '../services/trustedDialog'
import {
  getAgentRuntimeCoordinator,
  observeAgentRunEvents,
  startConversationRun
} from './agentRuns'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import { loadStoredSettings } from './settings'
import { appState, getDb, getStore } from './state'

/** The port phones remember, so a saved home-screen icon keeps working. */
const DEFAULT_PORT = 47615

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json'
}

const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')
// The development server injects inline scripts for hot reload.
const DEVELOPMENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"

const MANIFEST = JSON.stringify({
  name: 'SideKick',
  short_name: 'SideKick',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#111111',
  theme_color: '#111111',
  icons: [{ src: '/companion-icon.png', sizes: '512x512', type: 'image/png' }]
})

const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())

let server: CompanionServer | null = null
let companionApi: CompanionApi | null = null
let devices: CompanionDeviceStore | null = null
let startError: string | null = null
let pendingChange: ReturnType<typeof setTimeout> | null = null

function deviceStore(): CompanionDeviceStore {
  devices ??= new CompanionDeviceStore(getDb(), {
    isAvailable: isSecureCredentialStorageAvailable,
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
  })
  return devices
}

function rendererDirectory(): string {
  return join(__dirname, '../renderer')
}

/** The phone page's files. Only the page, its built assets, its manifest and its icon are served. */
async function staticFile(path: string): Promise<CompanionStaticFile | null> {
  if (path === '/companion.webmanifest')
    return { body: Buffer.from(MANIFEST), type: 'application/manifest+json' }
  if (path === '/companion-icon.png') return { body: await fs.readFile(icon), type: 'image/png' }
  const page = path === '/' || path === '/companion.html'
  const development = process.env.ELECTRON_RENDERER_URL
  if (development) {
    // In development the page and its modules come from the renderer's development server. Only
    // the paths a page loads are passed on: it can also read files elsewhere on disk.
    if (!page && !isDevelopmentPagePath(path)) return null
    const response = await fetch(new URL(page ? '/companion.html' : path, development)).catch(
      () => null
    )
    if (!response?.ok) return null
    return {
      body: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get('content-type') ?? 'application/octet-stream'
    }
  }
  if (page)
    return {
      body: await fs.readFile(join(rendererDirectory(), 'companion.html')),
      type: CONTENT_TYPES['.html']
    }
  const asset = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(path)?.[1]
  if (!asset || asset.startsWith('.')) return null
  const type = CONTENT_TYPES[extname(asset).toLowerCase()]
  if (!type) return null
  const body = await fs.readFile(join(rendererDirectory(), 'assets', asset)).catch(() => null)
  return body ? { body, type } : null
}

function resolveModel(conversationId: string): ReturnType<typeof resolveConversationModel> {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  const coordinator = getAgentRuntimeCoordinator()
  return resolveConversationModel(
    pinnedModelsFromProviderInstances(settings.providerInstances ?? []),
    {
      own: conversationId ? coordinator.conversationModels.get(conversationId) : null,
      latestRun: conversationId ? coordinator.store.latest(conversationId) : null,
      defaultModelId: settings.selectedModel
    }
  )
}

async function approve(
  request: { name: string; address: string },
  signal: AbortSignal
): Promise<boolean> {
  const result = await showTrustedDialog(
    appState.mainWindowRef,
    {
      type: 'question',
      buttons: ["Don't allow", 'Allow'],
      cancelId: 0,
      defaultId: 0,
      message: `Allow “${request.name}” to use SideKick?`,
      detail: `It is at ${request.address} on your network. It will see your chats and can send messages, stop the agent and answer its questions. Allow it only if it is your own phone and you just scanned the code.`
    },
    { signal, reveal: true }
  )
  return result.response === 1 && !signal.aborted
}

function companionServer(): CompanionServer {
  if (server) return server
  const coordinator = getAgentRuntimeCoordinator()
  const api = new CompanionApi({
    db: getDb(),
    startRun: startConversationRun,
    stopRun: async (runId) => coordinator.stop(runId),
    runEvents: async (runId, afterSequence) => coordinator.events(runId, afterSequence),
    latestRun: (conversationId) => coordinator.store.latest(conversationId),
    run: (runId) => coordinator.store.get(runId),
    interaction: (id) => coordinator.store.getInteraction(id),
    resolveInteraction: async (input) => coordinator.resolveInteraction(input),
    steer: (conversationId, message, onApplied) =>
      coordinator.steerUserMessage(conversationId, message, onApplied),
    resolveModel,
    messagesChanged: (conversationId) => {
      publishDesktopEvent('conversations:messagesChanged', { conversationId })
      server?.broadcast({ type: 'messages.changed', conversationId })
    }
  })
  companionApi = api
  server = new CompanionServer({
    devices: deviceStore(),
    approve,
    handle: (call, input) => api.handle(call, input),
    staticFile,
    contentSecurityPolicy: process.env.ELECTRON_RENDERER_URL ? DEVELOPMENT_CSP : PRODUCTION_CSP,
    onChange: notifyChanged
  })
  return server
}

function qrModules(text: string): boolean[][] {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => code.isDark(row, column))
  )
}

export function companionStatus(): CompanionStatus {
  const listening = server?.listening ?? null
  const pairing = listening ? server!.pairingInfo() : null
  const connected = server?.connectedDeviceIds() ?? new Set<string>()
  return {
    enabled: Boolean(listening),
    error: startError,
    address: listening ? server!.baseUrl() : null,
    pairing: pairing ? { ...pairing, modules: qrModules(pairing.url) } : null,
    awaitingApproval: server?.awaitingApproval() ?? null,
    devices: deviceStore()
      .list()
      .map((device) => ({ ...device, connected: connected.has(device.id) }))
  }
}

/** Status changes arrive in bursts (a stream opening, a pairing ending); the window gets one. */
function notifyChanged(): void {
  if (pendingChange) return
  pendingChange = setTimeout(() => {
    pendingChange = null
    publishDesktopEvent('companion:changed', companionStatus())
  }, 50)
}

async function setEnabled(enabled: boolean): Promise<CompanionStatus> {
  getStore().set('companionEnabled', enabled)
  startError = null
  if (!enabled) {
    await server?.stop()
    notifyChanged()
    return companionStatus()
  }
  const address = pickLocalNetworkAddress(networkInterfaces())
  if (!address) {
    startError = 'This computer is not on a local network. Connect to Wi-Fi and try again.'
    notifyChanged()
    return companionStatus()
  }
  const target = companionServer()
  try {
    const preferred = Number(getStore().get('companionPort', DEFAULT_PORT)) || DEFAULT_PORT
    const listening = await target.start(address, preferred)
    getStore().set('companionPort', listening.port)
    target.newPairing()
  } catch (error) {
    console.warn('[Companion] Could not start:', error)
    startError = 'Phone access could not start on this network.'
  }
  notifyChanged()
  return companionStatus()
}

function forwardRunEvent(event: CompanionEvent & { type: 'run.event' }): void {
  if (!server?.listening) return
  server.broadcast(event)
  if (
    event.event.type === 'run.started' ||
    event.event.type === 'run.finalized' ||
    event.event.type === 'run.phase'
  )
    server.broadcast({ type: 'chats.changed' })
}

export function registerCompanionHandlers(): void {
  ipcMain.handle('companion:status', () => companionStatus())
  ipcMain.handle('companion:setEnabled', (_event, enabled: unknown) => setEnabled(enabled === true))
  ipcMain.handle('companion:newCode', () => {
    server?.newPairing()
    notifyChanged()
    return companionStatus()
  })
  ipcMain.handle('companion:removeDevice', (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 100)
      throw new Error('Invalid device')
    deviceStore().remove(deviceId)
    server?.disconnect(deviceId)
    notifyChanged()
    return companionStatus()
  })
  observeAgentRunEvents((event) => {
    if (event.type === 'run.finalized') companionApi?.runEnded(event.runId)
    // Phones get the same events the window does, small enough to carry.
    if (server?.listening)
      forwardRunEvent({ type: 'run.event', event: trimForPhone(event) as typeof event })
  })
  // Phone access stays on across restarts once the user turned it on.
  if (getStore().get('companionEnabled', false) === true)
    void setEnabled(true).catch((error) => console.warn('[Companion] Could not start:', error))
}

export async function shutdownCompanion(): Promise<void> {
  await server?.stop()
}
