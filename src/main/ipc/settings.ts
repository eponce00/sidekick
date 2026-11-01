import { app, BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from 'electron'
import { normalizePermissionMode } from '../../shared/permissions'
import type { McpServerConfig } from '../../shared/types'
import type { PinnedModel } from '../../shared/models'
import type { ProviderSettings } from '../../shared/settings'
import {
  migrateLegacyProviderInstances,
  sameProviderBaseUrl,
  syncLegacyProviderSettings
} from '../../shared/providerInstances'
import { appState, getStore } from './state'
import { validateOfficeInterpreter } from '../services/officeHelperService'
import { randomUUID } from 'node:crypto'
import { isSecureCredentialStorageAvailable } from '../services/secureCredentialStorage'
import {
  approveMcpServers,
  changedMcpServers,
  isMcpServerApproved,
  MCP_ENV_SECRETS_KEY,
  retainedMcpEnvironment
} from '../services/mcpServerTrust'
import { showTrustedDialog } from '../services/trustedDialog'
import { RETIRED_SETTING_KEYS } from '../../shared/settingsSchema'
import { ACCENT_PALETTE_VERSION, migrateAccentPalette } from '../../shared/accentPalettes'
import { legacyTextScale } from '../../shared/textScale'
import {
  resolveStoredToolCallLimit,
  TOOL_CALL_LIMIT_POLICY_VERSION
} from '../../shared/agentLimits'

const CREDENTIAL_STORAGE_ERROR =
  'Secure credential storage is unavailable. Unlock or enable your operating system keychain or password manager, then try again. Settings without new credentials can still be saved.'

function encryptCredential(secret: string): string {
  if (!isSecureCredentialStorageAvailable()) throw new Error(CREDENTIAL_STORAGE_ERROR)
  try {
    return safeStorage.encryptString(secret).toString('base64')
  } catch {
    // Native errors are not safe to echo into IPC or logs.
    throw new Error(CREDENTIAL_STORAGE_ERROR)
  }
}

const SECRET_KEYS = ['openRouterApiKey', 'ollamaCloudApiKey', 'lmStudioApiKey'] as const
export type SettingsRecord = Record<string, unknown> & {
  __encryptedSecrets?: Record<string, string>
  __encryptedProviderSecrets?: Record<string, string>
}

const LEGACY_SECRET_PROVIDER_TYPES: Partial<Record<(typeof SECRET_KEYS)[number], string>> = {
  openRouterApiKey: 'openrouter',
  ollamaCloudApiKey: 'ollama-cloud',
  lmStudioApiKey: 'openai-compatible'
}

function providerTypeHasSecret(
  settings: SettingsRecord,
  providerSecrets: Record<string, string>,
  type: string
): boolean {
  return (
    Array.isArray(settings.providerInstances) &&
    settings.providerInstances.some((raw) => {
      if (!raw || typeof raw !== 'object') return false
      const instance = raw as Record<string, unknown>
      return (
        instance.type === type &&
        typeof instance.id === 'string' &&
        Boolean(providerSecrets[instance.id])
      )
    })
  )
}

export function protectSettings(value: unknown, existingValue?: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const settings = { ...(value as SettingsRecord) }
  const existing =
    existingValue && typeof existingValue === 'object'
      ? (existingValue as SettingsRecord)
      : undefined
  const encrypted = {
    ...(existing?.__encryptedSecrets ?? {})
  }
  for (const key of SECRET_KEYS) {
    // Migrate a historical plaintext fallback on the next save. If the vault is
    // locked, encryption fails before persistence instead of silently losing it.
    const secret = settings[key] === undefined ? existing?.[key] : settings[key]
    if (typeof secret === 'string' && secret) {
      encrypted[key] = encryptCredential(secret)
    } else if (secret === '') {
      delete encrypted[key]
    }
    delete settings[key]
  }
  settings.__encryptedSecrets = encrypted
  const providerSecrets = {
    ...(existing?.__encryptedProviderSecrets ?? {})
  }
  if (Array.isArray(settings.providerInstances)) {
    const retainedProviderIds = new Set<string>()
    settings.providerInstances = settings.providerInstances.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const instance = { ...(raw as Record<string, unknown>) }
      const id = typeof instance.id === 'string' ? instance.id : ''
      const previousInstance = Array.isArray(existing?.providerInstances)
        ? existing.providerInstances.find(
            (candidate) => candidate && typeof candidate === 'object' && candidate.id === id
          )
        : undefined
      // A saved key goes only to the address it was saved with; moving the provider without a
      // new key drops it, so the user enters it again for the new address.
      const moved =
        previousInstance !== undefined &&
        !sameProviderBaseUrl(previousInstance.baseUrl, instance.baseUrl)
      const secret =
        instance.apiKey === undefined ? (moved ? '' : previousInstance?.apiKey) : instance.apiKey
      delete instance.apiKeyConfigured
      if (id) retainedProviderIds.add(id)
      if (id && typeof secret === 'string' && secret) {
        providerSecrets[id] = encryptCredential(secret)
      } else if (id && secret === '') {
        delete providerSecrets[id]
      }
      delete instance.apiKey
      return instance
    })
    for (const id of Object.keys(providerSecrets)) {
      if (!retainedProviderIds.has(id)) delete providerSecrets[id]
    }
  }
  for (const key of SECRET_KEYS) {
    const providerType = LEGACY_SECRET_PROVIDER_TYPES[key]
    if (providerType && providerTypeHasSecret(settings, providerSecrets, providerType)) {
      delete encrypted[key]
    }
  }
  settings.__encryptedProviderSecrets = providerSecrets
  settings[MCP_ENV_SECRETS_KEY] = retainedMcpEnvironment(existing, settings.mcpServers)
  return settings
}

export function revealSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const settings = { ...(value as SettingsRecord) }
  const encrypted = settings.__encryptedSecrets
  const providerSecrets = settings.__encryptedProviderSecrets
  delete settings.__encryptedSecrets
  delete settings.__encryptedProviderSecrets
  // MCP server environments are decrypted only when a server starts.
  delete settings[MCP_ENV_SECRETS_KEY]
  if (!isSecureCredentialStorageAvailable()) {
    // Never expose old plaintext fallback values while secure storage is locked.
    for (const key of SECRET_KEYS) {
      settings[`${key}Configured`] = Boolean(encrypted?.[key])
      delete settings[key]
    }
    if (Array.isArray(settings.providerInstances)) {
      settings.providerInstances = settings.providerInstances.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw
        const instance = { ...(raw as Record<string, unknown>) }
        const id = typeof instance.id === 'string' ? instance.id : ''
        instance.apiKeyConfigured = Boolean(id && providerSecrets?.[id])
        delete instance.apiKey
        return instance
      })
    }
    return settings
  }
  if (encrypted) {
    for (const key of SECRET_KEYS) {
      const encoded = encrypted[key]
      if (!encoded) continue
      const providerType = LEGACY_SECRET_PROVIDER_TYPES[key]
      if (
        providerType &&
        providerSecrets &&
        providerTypeHasSecret(settings, providerSecrets, providerType)
      ) {
        continue
      }
      try {
        settings[key] = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      } catch {
        console.warn('[Settings] Could not decrypt a stored credential.')
        settings[`${key}Configured`] = true
        delete settings[key]
      }
    }
  }
  if (Array.isArray(settings.providerInstances) && providerSecrets) {
    settings.providerInstances = settings.providerInstances.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const instance = { ...(raw as Record<string, unknown>) }
      const id = typeof instance.id === 'string' ? instance.id : ''
      const encoded = id ? providerSecrets[id] : undefined
      if (encoded) {
        try {
          instance.apiKey = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
        } catch {
          console.warn('[Settings] Could not decrypt a stored provider credential.')
          instance.apiKeyConfigured = true
          delete instance.apiKey
        }
      }
      return instance
    })
  }
  return settings
}

export function loadStoredSettings(): SettingsRecord {
  const store = getStore()
  const settings = asSettingsRecord(revealSettings(store.get('settings', {})))
  if (settings.providerInstances) return settings
  // Settings from before provider instances wait for an unlocked keychain to be migrated. Until
  // then read them the way the renderer shows them, so a chat on one of those models finds it.
  const providerInstances = migrateLegacyProviderInstances(
    settings as unknown as ProviderSettings,
    store.get('pinnedModels', []) as PinnedModel[]
  )
  return { ...settings, providerInstances }
}

/**
 * Changes stored settings in one synchronous read-modify-write. Each writer starts from what is
 * stored at that moment, so none can write back another writer's fields from an older copy.
 */
function updateStoredSettings(change: (current: SettingsRecord) => SettingsRecord): SettingsRecord {
  const store = getStore()
  const stored = store.get('settings', {})
  const next = asSettingsRecord(change(asSettingsRecord(revealSettings(stored))))
  store.set('settings', protectSettings(next, stored))
  return next
}

/**
 * `current` with the settings a save names replaced. Settings it leaves out keep their stored
 * values, and the Office helper identity stays main-owned whatever the save supplies.
 */
function applySettingsChanges(current: SettingsRecord, changes: SettingsRecord): SettingsRecord {
  const next = { ...current, ...changes }
  next.officeHelperConfigurationId =
    current.officeHelperInterpreter !== next.officeHelperInterpreter ||
    current.shellIsolation !== next.shellIsolation
      ? randomUUID()
      : current.officeHelperConfigurationId
  return next
}

/**
 * Saves settings a main-process caller changes, such as the phone choosing how hard a model
 * thinks, the way a save from the window applies them.
 */
export function saveSettingsChanges(changes: SettingsRecord): SettingsRecord {
  return updateStoredSettings((current) => applySettingsChanges(current, changes))
}

export function publicSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const settings = { ...(value as SettingsRecord) }
  delete settings.__encryptedSecrets
  delete settings.__encryptedProviderSecrets
  delete settings[MCP_ENV_SECRETS_KEY]
  for (const key of SECRET_KEYS) {
    const secret = settings[key]
    settings[`${key}Configured`] =
      settings[`${key}Configured`] === true || (typeof secret === 'string' && Boolean(secret))
    delete settings[key]
  }
  if (Array.isArray(settings.providerInstances)) {
    settings.providerInstances = settings.providerInstances.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const instance = { ...(raw as Record<string, unknown>) }
      instance.apiKeyConfigured =
        instance.apiKeyConfigured === true ||
        (typeof instance.apiKey === 'string' && Boolean(instance.apiKey))
      delete instance.apiKey
      return instance
    })
  }
  return settings
}

/**
 * Brings stored settings up to date as they load, here in one synchronous step. A renderer that
 * migrated them and saved its copy back would undo any save made in between, such as a provider
 * added moments after the window opened.
 */
function migrateStoredSettings(store: ReturnType<typeof getStore>): SettingsRecord {
  const stored = asSettingsRecord(store.get('settings', {}))
  let next = upgradeSettingsRecord(stored)
  // Defer the provider migration rather than persisting a credential-less projection while the
  // keychain is locked. The encrypted credentials stay untouched.
  if (!next.providerInstances && isSecureCredentialStorageAvailable()) {
    const revealed = asSettingsRecord(revealSettings(next)) as unknown as ProviderSettings
    const pinnedModels = store.get('pinnedModels', []) as PinnedModel[]
    const providerInstances = migrateLegacyProviderInstances(revealed, pinnedModels)
    const migrated = syncLegacyProviderSettings({ ...revealed, providerInstances })
    next = protectSettings(migrated, next) as SettingsRecord
  }
  if (next !== stored) store.set('settings', next)
  return asSettingsRecord(revealSettings(next))
}

/**
 * Stored settings without the ones SideKick no longer has, and with the tool-call limit and accent
 * palette moved to their current policies. No credential is touched, so this also runs while the
 * keychain is locked. Returns `stored` itself when nothing changes.
 */
function upgradeSettingsRecord(stored: SettingsRecord): SettingsRecord {
  const retired = RETIRED_SETTING_KEYS.filter((key) => Object.hasOwn(stored, key))
  const toolCallLimitCurrent = stored.toolCallLimitVersion === TOOL_CALL_LIMIT_POLICY_VERSION
  if (
    !retired.length &&
    toolCallLimitCurrent &&
    stored.accentPaletteVersion === ACCENT_PALETTE_VERSION
  )
    return stored
  const upgraded: SettingsRecord = migrateAccentPalette({
    ...(stored as SettingsRecord & { accentPalette?: string; accentPaletteVersion?: number })
  })
  for (const key of retired) delete upgraded[key]
  if (!toolCallLimitCurrent) {
    upgraded.toolCallLimit = resolveStoredToolCallLimit(
      stored.toolCallLimit,
      stored.toolCallLimitVersion
    )
    upgraded.toolCallLimitVersion = TOOL_CALL_LIMIT_POLICY_VERSION
  }
  return upgraded
}

function asSettingsRecord(value: unknown): SettingsRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings must be an object')
  }
  const serialized = JSON.stringify(value)
  if (serialized.length > 4 * 1024 * 1024) throw new Error('Settings payload is too large')
  return value as SettingsRecord
}

// The approval dialog lists at most this many servers; the rest are asked about separately.
const MAX_SERVERS_PER_APPROVAL = 8

/**
 * Enabled servers this save adds, edits, or switches on that are not approved in their current
 * form. Servers left untouched are not swept into an unrelated save; they keep waiting for their
 * own "Review and allow".
 */
export function mcpServersNeedingApproval(
  previous: SettingsRecord,
  next: SettingsRecord
): McpServerConfig[] {
  const changed = new Set(changedMcpServers(previous.mcpServers, next.mcpServers).map((s) => s.id))
  const wasEnabled = new Set(
    (Array.isArray(previous.mcpServers) ? (previous.mcpServers as McpServerConfig[]) : [])
      .filter((server) => server && server.enabled !== false)
      .map((server) => server.id)
  )
  return (Array.isArray(next.mcpServers) ? (next.mcpServers as McpServerConfig[]) : [])
    .filter(
      (server) =>
        server &&
        typeof server.id === 'string' &&
        server.enabled !== false &&
        (changed.has(server.id) || (!wasEnabled.has(server.id) && !isMcpServerApproved(server)))
    )
    .slice(0, MAX_SERVERS_PER_APPROVAL)
}

/** Everything that decides what a server runs or contacts; environment values never appear. */
export function describeMcpServer(server: McpServerConfig): string {
  const lines = [`${server.name || server.id} (${server.id})`]
  if (server.transport === 'streamable-http') {
    lines.push(`  URL: ${server.url}`, `  Sign-in: ${server.authentication}`)
  } else {
    lines.push(`  Command: ${server.command}`)
    if (server.args?.length) lines.push(`  Arguments: ${JSON.stringify(server.args)}`)
    if (server.cwd) lines.push(`  Working folder: ${server.cwd}`)
    if (server.envKeys?.length) {
      lines.push(`  Environment: ${server.envKeys.join(', ')} (values hidden)`)
    }
  }
  if (server.approvalMode === 'reads-auto') lines.push('  Read-only tools run without asking')
  return lines.join('\n').slice(0, 1_500)
}

export async function confirmSensitiveSettingsChange(
  previous: SettingsRecord,
  next: SettingsRecord,
  sender: WebContents | null,
  requester?: string
): Promise<boolean> {
  const enablingFullAccess =
    normalizePermissionMode(previous.commandPermissionMode) !== 'full-access' &&
    normalizePermissionMode(next.commandPermissionMode) === 'full-access'
  const mcpServers = mcpServersNeedingApproval(previous, next)
  const mcpChanged = mcpServers.length > 0
  const disablingShellIsolation =
    previous.shellIsolation === 'docker' && next.shellIsolation !== 'docker'
  const officeInterpreterChanged =
    previous.officeHelperInterpreter !== next.officeHelperInterpreter &&
    Boolean(next.officeHelperInterpreter)
  const enablingComputerUse =
    next.computerUseEnabled === true && previous.computerUseEnabled !== true
  const enablingChromeUse = next.chromeUseEnabled === true && previous.chromeUseEnabled !== true
  if (
    !enablingFullAccess &&
    !mcpChanged &&
    !disablingShellIsolation &&
    !officeInterpreterChanged &&
    !enablingComputerUse &&
    !enablingChromeUse
  )
    return true

  const reasons = [
    requester ? `Requested by ${requester}, not from the Settings window.` : null,
    officeInterpreterChanged
      ? 'The selected Office Python executable will run trusted bundled read-only helpers with your account permissions in host mode. Only choose an interpreter you trust. No dependencies will be installed.'
      : null,
    disablingShellIsolation
      ? 'Shell commands will leave container isolation and run directly on this computer with your account permissions.'
      : null,
    enablingFullAccess
      ? 'Full access lets in-scope agent operations run without approval prompts.'
      : null,
    enablingComputerUse
      ? 'The agent will be able to ask to operate apps on this computer, each only after you allow it.'
      : null,
    enablingChromeUse
      ? 'The agent will be able to work in your own Chrome, with your sign-ins, on most sites without asking. It asks before sites for email, money or your account.'
      : null,
    mcpChanged
      ? `These MCP connectors are new or changed. Local connectors launch processes with your account's permissions; remote connectors send requests to the listed endpoint. SideKick asks again whenever one changes.\n\n${mcpServers.map(describeMcpServer).join('\n\n')}`
      : null
  ]
    .filter(Boolean)
    .join('\n\n')
  const options = {
    type: 'warning' as const,
    title: 'Confirm security-sensitive settings',
    message: 'Apply security-sensitive settings?',
    detail: reasons,
    buttons: ['Cancel', 'Apply settings'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const window = sender ? BrowserWindow.fromWebContents(sender) : appState.mainWindowRef
  const parent = window && !window.isDestroyed() ? window : null
  // Without a sender the change came from the command line just now, so SideKick comes up to ask.
  const result = await showTrustedDialog(parent, options, { reveal: !sender })
  return result.response === 1
}

const settingsSavedListeners = new Set<(settings: SettingsRecord) => void>()

/** Lets main-process services follow settings the user saves. */
export function onSettingsSaved(listener: (settings: SettingsRecord) => void): () => void {
  settingsSavedListeners.add(listener)
  return () => settingsSavedListeners.delete(listener)
}

export function notifySettingsSaved(settings: SettingsRecord): void {
  for (const listener of settingsSavedListeners) listener(settings)
}

const LEGACY_ZOOM_KEY = 'desktopZoomFactorV1'

/**
 * Earlier versions sized the window and the conversation text separately. Folds both into the one
 * text size, keeping what the user saw, and drops the old values.
 */
export function migrateTextScale(): void {
  const store = getStore()
  const zoom = store.get(LEGACY_ZOOM_KEY)
  const stored = asSettingsRecord(store.get('settings', {}))
  if (typeof zoom !== 'number' && !Object.hasOwn(stored, 'contentFontSize')) return
  updateStoredSettings((current) => {
    const next = { ...current }
    if (next.textScale === undefined) next.textScale = legacyTextScale(zoom, next.contentFontSize)
    delete next.contentFontSize
    return next
  })
  store.delete(LEGACY_ZOOM_KEY)
}

export function registerSettingsHandlers(): void {
  const store = getStore()
  migrateTextScale()
  ipcMain.handle('settings:selectOfficeInterpreter', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose trusted Python executable for Office helpers',
      properties: ['openFile'] as ['openFile']
    }
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || selected.filePaths.length !== 1) return { canceled: true }
    try {
      return { canceled: false, path: await validateOfficeInterpreter(selected.filePaths[0]) }
    } catch {
      return { canceled: false, error: 'Selected interpreter is unavailable or invalid' }
    }
  })

  // Listing and forgetting only: nothing but SideKick's own dialog may add an app.
  ipcMain.handle('chromeUse:status', async () =>
    (await import('../services/chromeUseHost')).chromeUseStatus()
  )
  // Only ever opens SideKick's own question, which is what decides.
  ipcMain.handle('chromeUse:setUp', async () =>
    (await import('../services/chromeUseHost')).setUpChromeUse()
  )
  // Only ever takes access away, so it has nothing to ask.
  ipcMain.handle('chromeUse:disconnect', async () =>
    (await import('../services/chromeUseHost')).disconnectChromeUse()
  )
  ipcMain.handle('computerUse:rememberedApps', async () => {
    const apps = await (await import('../services/computerUseHost')).rememberedApps.list()
    return Promise.all(
      apps.map(async (allowed) => {
        const icon = await app.getFileIcon(allowed.path, { size: 'large' }).catch(() => null)
        return icon && !icon.isEmpty() ? { ...allowed, iconDataUrl: icon.toDataURL() } : allowed
      })
    )
  })
  ipcMain.handle('computerUse:forgetApp', async (_event, path: unknown) => {
    if (typeof path !== 'string') return
    await (await import('../services/computerUseHost')).rememberedApps.remove(path)
  })

  // A save names only the settings it changes; every other setting keeps what is stored.
  ipcMain.handle('settings:save', async (event, changes) => {
    try {
      const patch = asSettingsRecord(changes)
      if (patch.officeHelperInterpreter !== undefined)
        patch.officeHelperInterpreter = await validateOfficeInterpreter(
          patch.officeHelperInterpreter
        )
      const previous = asSettingsRecord(revealSettings(store.get('settings', {})))
      const proposed = { ...previous, ...patch }
      const approvedServers = mcpServersNeedingApproval(previous, proposed)
      if (!(await confirmSensitiveSettingsChange(previous, proposed, event.sender))) {
        return { success: false, error: 'Settings change cancelled' }
      }
      // The approval dialog can stay open for a while; apply the change to what is stored now.
      const saved = updateStoredSettings((current) => applySettingsChanges(current, patch))
      if (approvedServers.length) approveMcpServers(approvedServers)
      notifySettingsSaved(saved)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('settings:load', async () => {
    return publicSettings(migrateStoredSettings(store))
  })

  ipcMain.handle('pinnedModels:save', async (_, models) => {
    store.set('pinnedModels', models)
    return { success: true }
  })

  ipcMain.handle('pinnedModels:load', async () => {
    return store.get('pinnedModels', [])
  })
}
