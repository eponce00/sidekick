import { BrowserWindow, ipcMain, nativeImage, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { networkInterfaces } from 'os'
import { extname, join } from 'path'
import qrcode from 'qrcode-generator'
import icon from '../../../resources/icon.png?asset'
import {
  COMPANION_IMAGE_SIDE,
  type CompanionEvent,
  type CompanionImage,
  type CompanionStatus
} from '../../shared/companion'
import type { MessageImageAttachment } from '../../shared/messageImages'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import { checkpointPermissionOperation } from '../../shared/permissions'
import { readBrowserArtifact } from '../bootstrap/artifactProtocol'
import { hardResetCheckpoint, rewindToBeforeCheckpoint } from '../services/checkpoints'
import { permissionBroker } from '../services/permissionBroker'
import { CompanionApi, trimForPhone, type CompanionVoice } from '../services/companion/companionApi'
import {
  certificateServes,
  createCompanionCertificate,
  type CompanionCertificate
} from '../services/companion/companionCertificate'
import { CompanionDeviceStore } from '../services/companion/companionDeviceStore'
import {
  isDevelopmentPagePath,
  pickLocalNetworkAddress
} from '../services/companion/companionNetwork'
import { CompanionServer, type CompanionStaticFile } from '../services/companion/companionServer'
import { resolveConversationModel } from '../services/conversationModelStore'
import { isSecureCredentialStorageAvailable } from '../services/secureCredentialStorage'
import { showTrustedDialog } from '../services/trustedDialog'
import type { VoiceService } from '../services/voice/voiceService'
import {
  getAgentRuntimeCoordinator,
  observeAdmissionChanges,
  observeAgentRunEvents,
  startConversationRun
} from './agentRuns'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import { createChatWorktree, getManagedWorktrees } from './worktrees'
import { loadStoredSettings } from './settings'
import { appState, getDb, getStore } from './state'

/** A tenth of a second at 16 kHz, as a microphone sends it. */
const DICTATION_PIECE = 1_600

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

/**
 * The page's certificate for this address. It is kept, so a phone that accepted it is not warned
 * again, until the computer moves to another address or it nears its end. The key is sealed where
 * the system can seal it.
 */
function certificateFor(address: string): CompanionCertificate {
  const saved = getStore().get('companionCertificate') as
    | { cert?: unknown; key?: unknown; sealed?: unknown }
    | undefined
  if (
    typeof saved?.cert === 'string' &&
    typeof saved.key === 'string' &&
    certificateServes(saved.cert, address)
  ) {
    try {
      const key = saved.sealed
        ? safeStorage.decryptString(Buffer.from(saved.key, 'base64'))
        : saved.key
      return { cert: saved.cert, key }
    } catch {
      /* Made again below. */
    }
  }
  const made = createCompanionCertificate(address)
  const sealed = isSecureCredentialStorageAvailable()
  getStore().set('companionCertificate', {
    cert: made.cert,
    key: sealed ? safeStorage.encryptString(made.key).toString('base64') : made.key,
    sealed
  })
  return made
}

function rendererDirectory(): string {
  return join(__dirname, '../renderer')
}

/** The phone page's files. Only the page, its built assets, its manifest and its icon are served. */
async function staticFile(path: string, search: string): Promise<CompanionStaticFile | null> {
  if (path === '/companion.webmanifest')
    return { body: Buffer.from(MANIFEST), type: 'application/manifest+json' }
  if (path === '/companion-icon.png') return { body: await fs.readFile(icon), type: 'image/png' }
  const page = path === '/' || path === '/companion.html'
  const development = process.env.ELECTRON_RENDERER_URL
  if (development) {
    // In development the page and its modules come from the renderer's development server. Only
    // the paths a page loads are passed on: it can also read files elsewhere on disk.
    if (!page && !isDevelopmentPagePath(path)) return null
    // Imports such as `?raw` change what the development server returns, so the query is kept.
    const response = await fetch(
      new URL(page ? '/companion.html' : path + search, development)
    ).catch(() => null)
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

function enabledModels(): ReturnType<typeof pinnedModelsFromProviderInstances> {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  return pinnedModelsFromProviderInstances(settings.providerInstances ?? [])
}

/** See `resolveConversationModel`; an empty ID asks for the new-chat default. */
function resolveModel(
  conversationId: string,
  requested?: string
): ReturnType<typeof resolveConversationModel> {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  const coordinator = getAgentRuntimeCoordinator()
  return resolveConversationModel(enabledModels(), {
    requested,
    own: conversationId ? coordinator.conversationModels.get(conversationId) : null,
    latestRun: conversationId ? coordinator.store.latest(conversationId) : null,
    defaultModelId: settings.selectedModel
  })
}

/** A copy of an image no larger than a phone shows, so a chat of photos stays quick to open. */
async function shrinkImage(image: MessageImageAttachment): Promise<CompanionImage> {
  const original = nativeImage.createFromDataURL(image.dataUrl)
  const { width, height } = original.getSize()
  if (original.isEmpty() || Math.max(width, height) <= COMPANION_IMAGE_SIDE) return image
  const scale = COMPANION_IMAGE_SIDE / Math.max(width, height)
  const reduced = original.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'good'
  })
  return {
    id: image.id,
    name: image.name,
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${reduced.toJPEG(82).toString('base64')}`
  }
}

let voiceService: VoiceService | null = null

/** Lets phones use the computer's dictation and read-aloud. */
export function setCompanionVoice(service: VoiceService): void {
  voiceService = service
}

function companionVoice(): CompanionVoice | null {
  const service = voiceService
  if (!service) return null
  const ready = (id: 'dictation' | 'speech'): boolean => {
    const state = service.state()
    return state.enabled && state.models[id]?.status === 'ready'
  }
  return {
    state: () => {
      const state = service.state()
      return {
        dictation: ready('dictation'),
        speech: ready('speech'),
        message: !state.enabled
          ? 'Voice is turned off on the computer, in Settings › General.'
          : ready('dictation') && ready('speech')
            ? null
            : 'Voice is still being set up on the computer.'
      }
    },
    startDictation: async (dictationId, onText) => {
      const started = await service.startDictation(dictationId, onText)
      return started.ok ? { ok: true } : { ok: false, message: started.message }
    },
    // In the small pieces a microphone delivers: the speech detector reads audio a short window at
    // a time, and given seconds at once it heard only part of it.
    pushDictation: (dictationId, samples) => {
      for (let offset = 0; offset < samples.length; offset += DICTATION_PIECE)
        service.pushDictationAudio(dictationId, samples.slice(offset, offset + DICTATION_PIECE))
    },
    stopDictation: (dictationId) => service.stopDictation(dictationId),
    cancelDictation: (dictationId) => service.cancelDictation(dictationId),
    speak: async (speechId, text, onAudio, onEnd) => {
      const started = await service.speak(speechId, text, onAudio)
      if (!started.ok) return { ok: false, message: started.message }
      void started.finished?.then(() => onEnd()).catch((error: Error) => onEnd(error.message))
      if (!started.finished) onEnd()
      return { ok: true }
    },
    stop: (speechId) => service.stopSpeech(speechId)
  }
}

/** The window, which asks the user what the phone's request needs asked on the computer. */
function mainWindowContents(): Electron.WebContents {
  const window = appState.mainWindowRef
  if (!window || window.isDestroyed()) throw new Error('Open SideKick on the computer first')
  return window.webContents
}

/** As the window's Retry and Edit put files back: through the same permission check. */
async function restoreFiles(input: {
  workspaceRoot: string
  action: 'hard-reset' | 'rewind'
  hash: string
}): Promise<void> {
  const operation = checkpointPermissionOperation(input.action, input.hash, 'auto')
  const authorization = await permissionBroker.authorize(operation, mainWindowContents())
  if (!authorization.approved || !authorization.token)
    throw new Error(authorization.reason || 'Not allowed')
  permissionBroker.consume(authorization.token, operation)
  const result =
    input.action === 'hard-reset'
      ? await hardResetCheckpoint(input.workspaceRoot, input.hash)
      : await rewindToBeforeCheckpoint(input.workspaceRoot, input.hash)
  if (!result.ok) throw new Error('Files changed since that history point')
}

function queueChanged(conversationId: string): void {
  publishDesktopEvent('agentRuns:admissionsChanged', { conversationId })
  server?.broadcast({ type: 'queue.changed', conversationId })
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
    steerAdmission: (runId, admissionId) => coordinator.steer({ runId, admissionId }).accepted,
    models: enabledModels,
    resolveModel,
    setChatModel: (conversationId, modelId) =>
      coordinator.conversationModels.set(conversationId, modelId),
    messagesChanged: (conversationId) => {
      publishDesktopEvent('conversations:messagesChanged', { conversationId })
      server?.broadcast({ type: 'messages.changed', conversationId })
    },
    queueChanged,
    shrinkImage,
    readArtifact: readBrowserArtifact,
    voice: companionVoice,
    canUseWorktree: async (projectId) =>
      (await getManagedWorktrees().branchOptions(projectId)).isGitRepository,
    createWorktree: async (conversationId) => {
      await createChatWorktree(mainWindowContents(), { conversationId })
    },
    restoreFiles,
    sendToDevice: (deviceId, event) => server?.sendTo(deviceId, event)
  })
  companionApi = api
  server = new CompanionServer({
    devices: deviceStore(),
    approve,
    handle: (call, input, deviceId) => api.handle(call, input, deviceId),
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
    companionApi?.reset()
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
    const listening = await target.start(address, preferred, certificateFor(address))
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
    event.event.type === 'run.steered' ||
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
    if (event.type === 'run.steered' && server?.listening) {
      // A steered message leaves the queue as the run takes it.
      const run = getAgentRuntimeCoordinator().store.get(event.runId)
      if (run) server.broadcast({ type: 'queue.changed', conversationId: run.threadId })
    }
    if (event.type === 'run.finalized' && server?.listening) {
      const run = getAgentRuntimeCoordinator().store.get(event.runId)
      // A sub-agent's end is not its chat's; the chat's own run ending sends the next message.
      if (run && run.surface !== 'subagent') companionApi?.runEnded(run.threadId)
    }
    // Phones get the same events the window does, small enough to carry.
    if (server?.listening)
      forwardRunEvent({ type: 'run.event', event: trimForPhone(event) as typeof event })
  })
  // The window's own queue edits reach the phones too.
  observeAdmissionChanges((conversationId) =>
    server?.broadcast({ type: 'queue.changed', conversationId })
  )
  // Phone access stays on across restarts once the user turned it on.
  if (getStore().get('companionEnabled', false) === true)
    void setEnabled(true).catch((error) => console.warn('[Companion] Could not start:', error))
}

export async function shutdownCompanion(): Promise<void> {
  await server?.stop()
}
