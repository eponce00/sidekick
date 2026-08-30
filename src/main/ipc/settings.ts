import { BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from 'electron'
import { normalizePermissionMode } from '../../shared/permissions'
import type { McpServerConfig } from '../../shared/types'
import type { PinnedModel } from '../../shared/models'
import type { ProviderInstanceModel, ProviderSettings } from '../../shared/settings'
import {
  migrateLegacyProviderInstances,
  syncLegacyProviderSettings
} from '../../shared/providerInstances'
import { getStore } from './state'

const SECRET_KEYS = ['openRouterApiKey', 'ollamaCloudApiKey', 'lmStudioApiKey'] as const
type SettingsRecord = Record<string, unknown> & {
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
  if (!value || typeof value !== 'object' || !safeStorage.isEncryptionAvailable()) return value
  const settings = { ...(value as SettingsRecord) }
  const existing =
    existingValue && typeof existingValue === 'object'
      ? (existingValue as SettingsRecord)
      : undefined
  const encrypted = {
    ...(existing?.__encryptedSecrets ?? {}),
    ...(settings.__encryptedSecrets ?? {})
  }
  for (const key of SECRET_KEYS) {
    const secret = settings[key]
    if (typeof secret === 'string' && secret) {
      encrypted[key] = safeStorage.encryptString(secret).toString('base64')
    } else if (secret === '') {
      delete encrypted[key]
    }
    delete settings[key]
  }
  settings.__encryptedSecrets = encrypted
  const providerSecrets = {
    ...(existing?.__encryptedProviderSecrets ?? {}),
    ...(settings.__encryptedProviderSecrets ?? {})
  }
  if (Array.isArray(settings.providerInstances)) {
    const retainedProviderIds = new Set<string>()
    settings.providerInstances = settings.providerInstances.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const instance = { ...(raw as Record<string, unknown>) }
      const id = typeof instance.id === 'string' ? instance.id : ''
      const secret = instance.apiKey
      delete instance.apiKeyConfigured
      if (id) retainedProviderIds.add(id)
      if (id && typeof secret === 'string' && secret) {
        providerSecrets[id] = safeStorage.encryptString(secret).toString('base64')
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
  return settings
}

export function revealSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const settings = { ...(value as SettingsRecord) }
  const encrypted = settings.__encryptedSecrets
  const providerSecrets = settings.__encryptedProviderSecrets
  delete settings.__encryptedSecrets
  delete settings.__encryptedProviderSecrets
  if (!safeStorage.isEncryptionAvailable()) return settings
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
      } catch (error) {
        console.warn(`[Settings] Could not decrypt ${key}:`, error)
        settings[key] = ''
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
        } catch (error) {
          console.warn(`[Settings] Could not decrypt provider secret ${id}:`, error)
          delete instance.apiKey
        }
      }
      return instance
    })
  }
  return settings
}

export function loadStoredSettings(): SettingsRecord {
  return asSettingsRecord(revealSettings(getStore().get('settings', {})))
}

/** Atomically updates one persisted provider model while preserving encrypted secrets. */
export function updateStoredProviderModel(
  providerInstanceId: string,
  modelId: string,
  update: (model: ProviderInstanceModel) => ProviderInstanceModel
): ProviderInstanceModel {
  const store = getStore()
  const stored = store.get('settings', {})
  const settings = loadStoredSettings() as unknown as ProviderSettings
  const instances = settings.providerInstances || []
  let updated: ProviderInstanceModel | undefined
  const providerInstances = instances.map((instance) => {
    if (instance.id !== providerInstanceId) return instance
    return {
      ...instance,
      models: instance.models.map((model) => {
        if (model.id !== modelId) return model
        updated = update(model)
        return updated
      })
    }
  })
  if (!updated) {
    throw new Error(`Model ${modelId} was not found in provider ${providerInstanceId}`)
  }
  store.set('settings', protectSettings({ ...settings, providerInstances }, stored))
  return updated
}

export function publicSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const settings = { ...(value as SettingsRecord) }
  for (const key of SECRET_KEYS) {
    const secret = settings[key]
    settings[`${key}Configured`] = typeof secret === 'string' && Boolean(secret)
    delete settings[key]
  }
  if (Array.isArray(settings.providerInstances)) {
    settings.providerInstances = settings.providerInstances.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const instance = { ...(raw as Record<string, unknown>) }
      instance.apiKeyConfigured = typeof instance.apiKey === 'string' && Boolean(instance.apiKey)
      delete instance.apiKey
      return instance
    })
  }
  return settings
}

function migrateLegacySettingsForStorage(store: ReturnType<typeof getStore>): SettingsRecord {
  const stored = store.get('settings', {})
  const revealed = asSettingsRecord(revealSettings(stored)) as unknown as ProviderSettings
  if (revealed.providerInstances) return revealed as unknown as SettingsRecord
  const pinnedModels = store.get('pinnedModels', []) as PinnedModel[]
  const providerInstances = migrateLegacyProviderInstances(revealed, pinnedModels)
  const migrated = syncLegacyProviderSettings({ ...revealed, providerInstances })
  store.set('settings', protectSettings(migrated, stored))
  return asSettingsRecord(revealSettings(store.get('settings', {})))
}

function asSettingsRecord(value: unknown): SettingsRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings must be an object')
  }
  const serialized = JSON.stringify(value)
  if (serialized.length > 4 * 1024 * 1024) throw new Error('Settings payload is too large')
  return value as SettingsRecord
}

function mcpSummary(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'No MCP servers configured.'
  return value
    .slice(0, 20)
    .map((item) => {
      const server = item as Partial<McpServerConfig> & Record<string, unknown>
      const args = Array.isArray(server.args) ? server.args.join(' ') : ''
      const target =
        server.transport === 'streamable-http' || server.url
          ? server.url || '(no URL)'
          : `${server.command || '(no command)'}${args ? ` ${args}` : ''}`
      return `${server.enabled === false ? '[disabled]' : '[enabled]'} ${server.name || server.id || 'unnamed'}: ${target}`
    })
    .join('\n')
    .slice(0, 3_000)
}

async function confirmSensitiveSettingsChange(
  previous: SettingsRecord,
  next: SettingsRecord,
  sender: WebContents
): Promise<boolean> {
  const enablingFullAccess =
    normalizePermissionMode(previous.commandPermissionMode) !== 'full-access' &&
    normalizePermissionMode(next.commandPermissionMode) === 'full-access'
  const mcpChanged =
    JSON.stringify(previous.mcpServers ?? []) !== JSON.stringify(next.mcpServers ?? [])
  if (!enablingFullAccess && !mcpChanged) return true

  const reasons = [
    enablingFullAccess
      ? 'Full access lets in-scope agent operations run without approval prompts.'
      : null,
    mcpChanged
      ? `MCP connector configuration changed. Local connectors may launch processes; remote connectors communicate with the listed HTTPS endpoint.\n\n${mcpSummary(next.mcpServers)}`
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
  const parent = BrowserWindow.fromWebContents(sender)
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

export function registerSettingsHandlers(): void {
  const store = getStore()

  ipcMain.handle('settings:save', async (event, settings) => {
    try {
      const next = asSettingsRecord(settings)
      const previous = asSettingsRecord(revealSettings(store.get('settings', {})))
      if (!(await confirmSensitiveSettingsChange(previous, next, event.sender))) {
        return { success: false, error: 'Settings change cancelled' }
      }
      store.set('settings', protectSettings(next, store.get('settings', {})))
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('settings:load', async () => {
    return publicSettings(migrateLegacySettingsForStorage(store))
  })

  ipcMain.handle('pinnedModels:save', async (_, models) => {
    store.set('pinnedModels', models)
    return { success: true }
  })

  ipcMain.handle('pinnedModels:load', async () => {
    return store.get('pinnedModels', [])
  })
}
