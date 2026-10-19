import { app, BrowserWindow, safeStorage } from 'electron'
import { join } from 'node:path'
import { CONTROL_PROTOCOL_VERSION } from '../../shared/controlProtocol'
import { providerUrlIsUnencryptedRemote } from '../../shared/providerInstances'
import { revealWindow } from '../bootstrap/windowActivation'
import { confirmMcpServer, mcpServerStatuses } from '../ipc/mcp'
import { confirmSensitiveSettingsChange, notifySettingsSaved } from '../ipc/settings'
import { appState, getStore } from '../ipc/state'
import {
  approveMcpServers,
  forgetMcpServerApproval,
  isMcpServerApproved,
  withMcpEnvironment
} from '../services/mcpServerTrust'
import { isBrowserParkingWindow } from '../services/browserViewHost'
import { isSecureCredentialStorageAvailable } from '../services/secureCredentialStorage'
import {
  createControlToken,
  createEndpointName,
  ensureControlDirectory,
  removeEndpointFile,
  writeEndpointFile
} from './controlEndpoint'
import { writeCliRuntime } from './commandLineTool'
import { createControlHandlers } from './controlMethods'
import type { ProviderEndpointChange } from './controlProviderMethods'
import { ControlServer, type ControlHandlers } from './controlServer'
import { showTrustedDialog } from '../services/trustedDialog'

function credentialBackend(): string {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return 'unknown'
  }
}

async function showDialog(options: Electron.MessageBoxOptions): Promise<number> {
  const parent = appState.mainWindowRef
  // The user asked for this change from the command line just now, so SideKick comes up to ask.
  const answer = await showTrustedDialog(parent && !parent.isDestroyed() ? parent : null, options, {
    reveal: true
  })
  return answer.response
}

/** Asks before a provider's prompts, and any stored key, are sent to a new address. */
async function confirmProviderEndpoint(
  change: ProviderEndpointChange,
  requester: string
): Promise<boolean> {
  const detail = [
    `Requested by ${requester}, not from the Settings window.`,
    change.previousUrl
      ? `${change.providerName} (${change.providerId}) will send requests to\n${change.nextUrl}\ninstead of\n${change.previousUrl}`
      : `${change.providerName} (${change.providerId}) will send requests to\n${change.nextUrl}`,
    change.keyStored
      ? 'The API key stored for this provider will be sent to the new address. Allow this only if you trust it.'
      : 'Any API key you store for this provider later will be sent to this address.',
    providerUrlIsUnencryptedRemote(change.nextUrl)
      ? 'This address is not encrypted, so others on the network can read what is sent.'
      : null
  ]
    .filter(Boolean)
    .join('\n\n')
  const response = await showDialog({
    type: 'warning',
    title: 'Confirm provider address',
    message: `Change where ${change.providerName} sends requests?`,
    detail,
    buttons: ['Cancel', 'Use this address'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return response === 1
}

/** Lets services and open windows follow a change made outside the Settings window. */
export function broadcastSettingsChanged(settings: Record<string, unknown>): void {
  notifySettingsSaved(settings)
  // Windows reload settings so a later save cannot overwrite this change with stale state.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !isBrowserParkingWindow(window)) {
      window.webContents.send('settings:changed')
    }
  }
}

/**
 * The control methods, for one requester. The CLI endpoint and SideKick's own agent use the same
 * methods, so the same validation, approvals, and secret handling apply to both; dialogs name
 * who asked.
 */
export function createAppControlHandlers(requester: string): ControlHandlers {
  const userData = app.getPath('userData')
  return createControlHandlers({
    store: getStore(),
    appVersion: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    settingsFile: join(userData, 'config.json'),
    credentialStorage: () => ({
      secure: isSecureCredentialStorageAvailable(),
      backend: credentialBackend()
    }),
    confirmSensitiveChange: (previous, next) =>
      confirmSensitiveSettingsChange(previous, next, null, requester),
    settingsChanged: broadcastSettingsChanged,
    mcpStatuses: mcpServerStatuses,
    confirmProviderEndpoint: (change) => confirmProviderEndpoint(change, requester),
    mcpTrust: {
      isApproved: isMcpServerApproved,
      approve: approveMcpServers,
      forget: forgetMcpServerApproval,
      withEnvironment: withMcpEnvironment,
      confirm: (config) => confirmMcpServer(config, appState.mainWindowRef, requester)
    }
  })
}

/** Opens Settings at a provider's key field; the key is typed into SideKick, never a chat. */
export function openProviderKeyPrompt(providerInstanceId: string): boolean {
  const window = appState.mainWindowRef
  if (!window || window.isDestroyed()) return false
  revealWindow(window)
  window.webContents.send('app:openProviderKey', providerInstanceId)
  return true
}

/**
 * Starts the endpoint the `sidekick` CLI talks to and returns a function that stops it. A
 * failure only disables the CLI; SideKick itself keeps running.
 */
export async function startControlEndpoint(): Promise<() => Promise<void>> {
  const userData = app.getPath('userData')
  const token = createControlToken()
  const endpoint = createEndpointName(ensureControlDirectory(userData))
  const server = new ControlServer({
    endpoint,
    token,
    appVersion: app.getVersion(),
    handlers: createAppControlHandlers('the sidekick command-line tool')
  })
  await server.start()
  writeEndpointFile(userData, {
    protocol: CONTROL_PROTOCOL_VERSION,
    endpoint,
    token,
    pid: process.pid,
    appVersion: app.getVersion()
  })
  const removeCliRuntime = writeCliRuntime(userData)
  return async () => {
    removeCliRuntime?.()
    removeEndpointFile(userData, token)
    await server.close()
  }
}
