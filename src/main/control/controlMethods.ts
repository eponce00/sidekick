import { randomUUID } from 'node:crypto'
import {
  CONTROL_MAX_SECRET_LENGTH,
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  type ControlDoctorReport,
  type ControlSettingChange,
  type ControlSettingEntry
} from '../../shared/controlProtocol'
import { resolveStoredToolCallLimit } from '../../shared/agentLimits'
import { normalizePermissionMode } from '../../shared/permissions'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderInstance } from '../../shared/settings'
import {
  EDITABLE_SETTINGS,
  editableSetting,
  isKnownStoredSettingKey,
  renderSettingsReference,
  validateSettingValue,
  type EditableSettingDescriptor,
  type EditableSettingValue
} from '../../shared/settingsSchema'
import type { McpServerConfig, McpServerStatus } from '../../shared/types'
import { protectSettings, type SettingsRecord } from '../ipc/settings'
import type { AppStore } from '../ipc/state'
import { createMcpControlHandlers, type McpControlDependencies } from './controlMcpMethods'
import {
  createProviderControlHandlers,
  type ProviderControlDependencies
} from './controlProviderMethods'
import type { ControlHandlers } from './controlServer'
import { providerInstances, storedSettings, withTimeout } from './controlStore'

export interface ControlMethodDependencies
  extends McpControlDependencies, ProviderControlDependencies {
  store: AppStore
  appVersion: string
  platform: string
  settingsFile: string
  credentialStorage: () => { secure: boolean; backend: string }
  /** Shows SideKick's approval dialog when a change weakens security. */
  confirmSensitiveChange: (previous: SettingsRecord, next: SettingsRecord) => Promise<boolean>
  /** Lets services and open windows follow a change made outside the Settings window. */
  settingsChanged: (settings: SettingsRecord) => void
  mcpStatuses: () => Promise<McpServerStatus[]>
  mcpStatusTimeoutMs?: number
}

const PROVIDER_INSTANCE_ID = /^[A-Za-z0-9_.-]{1,128}$/
const SECRET_LIKE_KEY = /api.?key|secret|token|password|credential/i

// Stored values the app migrates when it reads them; report what the app actually uses.
const STORED_VALUE_MIGRATIONS: Record<string, (value: unknown, stored: SettingsRecord) => unknown> =
  {
    commandPermissionMode: (value) => normalizePermissionMode(value),
    toolCallLimit: (value, stored) => resolveStoredToolCallLimit(value, stored.toolCallLimitVersion)
  }

function configuredModelIds(stored: SettingsRecord): string[] {
  try {
    return pinnedModelsFromProviderInstances(providerInstances(stored)).map((model) => model.id)
  } catch {
    return []
  }
}

function settingDescriptor(key: unknown): EditableSettingDescriptor {
  const descriptor = typeof key === 'string' ? editableSetting(key) : undefined
  if (descriptor) return descriptor
  if (typeof key === 'string' && SECRET_LIKE_KEY.test(key)) {
    throw new ControlError(
      'not-found',
      'API keys are not settings. Store one with `sidekick auth set <provider-instance> --stdin`.'
    )
  }
  throw new ControlError(
    'not-found',
    typeof key === 'string' && key.length <= 64 && /^[A-Za-z0-9_]+$/.test(key)
      ? `Unknown setting ${key}. Run \`sidekick config list\` to see the settings you can change.`
      : 'Unknown setting. Run `sidekick config list` to see the settings you can change.'
  )
}

function readSetting(
  stored: SettingsRecord,
  descriptor: EditableSettingDescriptor,
  modelIds: string[]
): { value: EditableSettingValue; isDefault: boolean; invalid?: string } {
  const raw = stored[descriptor.key]
  if (raw === undefined) return { value: descriptor.default, isDefault: true }
  const migrate = STORED_VALUE_MIGRATIONS[descriptor.key]
  const checked = validateSettingValue(descriptor, migrate ? migrate(raw, stored) : raw, modelIds)
  if (!checked.ok) return { value: descriptor.default, isDefault: true, invalid: checked.reason }
  return { value: checked.value, isDefault: false }
}

function entry(stored: SettingsRecord, descriptor: EditableSettingDescriptor): ControlSettingEntry {
  const { value, isDefault } = readSetting(stored, descriptor, configuredModelIds(stored))
  return { key: descriptor.key, value, isDefault, descriptor }
}

/**
 * The control methods. None of them returns a stored credential: settings outside the schema are
 * never read back, and provider keys are only ever reported as present or absent.
 */
export function createControlHandlers(deps: ControlMethodDependencies): ControlHandlers {
  const { store } = deps

  async function write(
    descriptor: EditableSettingDescriptor,
    apply: (settings: SettingsRecord) => void
  ): Promise<ControlSettingChange> {
    const before = storedSettings(store)
    const previous = readSetting(before, descriptor, configuredModelIds(before)).value
    const proposed = { ...before }
    apply(proposed)
    if (!(await deps.confirmSensitiveChange(before, proposed))) {
      throw new ControlError('denied', 'The change was declined in SideKick.')
    }
    // The approval dialog can stay open for a while; apply the change to what is stored now.
    const current = storedSettings(store)
    const next = { ...current }
    apply(next)
    if (descriptor.key === 'shellIsolation' && current.shellIsolation !== next.shellIsolation) {
      // Pending Office helper requests belong to the old isolation mode.
      next.officeHelperConfigurationId = randomUUID()
    }
    store.set('settings', next)
    deps.settingsChanged(next)
    const value = readSetting(next, descriptor, configuredModelIds(next)).value
    return { key: descriptor.key, previous, value, changed: previous !== value }
  }

  return {
    ...createMcpControlHandlers(deps),
    ...createProviderControlHandlers(deps),
    'config.list': async () => {
      const stored = storedSettings(store)
      return { settings: EDITABLE_SETTINGS.map((descriptor) => entry(stored, descriptor)) }
    },

    'config.get': async ({ key }) => entry(storedSettings(store), settingDescriptor(key)),

    'config.set': async ({ key, value }) => {
      const descriptor = settingDescriptor(key)
      const checked = validateSettingValue(
        descriptor,
        value,
        configuredModelIds(storedSettings(store))
      )
      if (!checked.ok) {
        throw new ControlError(
          'invalid-value',
          `Invalid value for ${descriptor.key}: ${checked.reason}.`
        )
      }
      return write(descriptor, (settings) => {
        settings[descriptor.key] = checked.value
        Object.assign(settings, descriptor.companions ?? {})
      })
    },

    'config.unset': async ({ key }) => {
      const descriptor = settingDescriptor(key)
      return write(descriptor, (settings) => {
        delete settings[descriptor.key]
      })
    },

    'config.reference': async () => ({ markdown: renderSettingsReference() }),

    'auth.set': async ({ providerInstanceId, secret }) => {
      if (
        typeof providerInstanceId !== 'string' ||
        !PROVIDER_INSTANCE_ID.test(providerInstanceId)
      ) {
        throw new ControlError('usage', 'Name a provider instance id from `sidekick doctor`.')
      }
      // Never repeat any part of the secret in an error.
      if (typeof secret !== 'string' || !secret) {
        throw new ControlError('invalid-value', 'The key is empty.')
      }
      if (secret.length > CONTROL_MAX_SECRET_LENGTH) {
        throw new ControlError('invalid-value', 'The key is too long to be an API key.')
      }
      // eslint-disable-next-line no-control-regex
      if (/[\s\u0000-\u001f\u007f]/.test(secret)) {
        throw new ControlError('invalid-value', 'The key contains spaces or control characters.')
      }
      const stored = storedSettings(store)
      const instances = providerInstances(stored)
      // The id is not echoed: a key pasted in its place must not reach the terminal.
      if (!instances.some((instance) => instance.id === providerInstanceId)) {
        throw new ControlError(
          'not-found',
          'No provider instance has that id. Run `sidekick doctor` to list them.'
        )
      }
      if (!deps.credentialStorage().secure) {
        throw new ControlError(
          'storage-locked',
          'Secure credential storage is unavailable. Unlock or enable your operating system keychain, then try again.'
        )
      }
      let next: SettingsRecord
      try {
        next = protectSettings(
          {
            ...stored,
            providerInstances: (stored.providerInstances as unknown[]).map((raw) =>
              raw && typeof raw === 'object' && (raw as ProviderInstance).id === providerInstanceId
                ? { ...(raw as ProviderInstance), apiKey: secret }
                : raw
            )
          },
          stored
        ) as SettingsRecord
      } catch {
        throw new ControlError(
          'storage-locked',
          'Secure credential storage could not encrypt the key. Unlock your operating system keychain, then try again.'
        )
      }
      store.set('settings', next)
      deps.settingsChanged(next)
      return { providerInstanceId, apiKeyConfigured: true }
    },

    doctor: async (): Promise<ControlDoctorReport> => {
      const stored = storedSettings(store)
      const modelIds = configuredModelIds(stored)
      const providerSecrets =
        stored.__encryptedProviderSecrets && typeof stored.__encryptedProviderSecrets === 'object'
          ? stored.__encryptedProviderSecrets
          : {}
      const configs = Array.isArray(stored.mcpServers)
        ? (stored.mcpServers as Array<Record<string, unknown>>).filter(
            (config) => config && typeof config === 'object' && typeof config.id === 'string'
          )
        : []
      const statuses = configs.length
        ? await withTimeout(deps.mcpStatuses(), deps.mcpStatusTimeoutMs ?? 5_000)
        : []
      return {
        appVersion: deps.appVersion,
        protocol: CONTROL_PROTOCOL_VERSION,
        platform: deps.platform,
        settingsFile: deps.settingsFile,
        unknownKeys: Object.keys(stored)
          .filter((key) => !isKnownStoredSettingKey(key))
          .sort(),
        invalidSettings: EDITABLE_SETTINGS.flatMap((descriptor) => {
          const { invalid } = readSetting(stored, descriptor, modelIds)
          return invalid ? [{ key: descriptor.key, reason: invalid }] : []
        }),
        credentialStorage: deps.credentialStorage(),
        providers: providerInstances(stored).map((instance) => ({
          id: instance.id,
          name: String(instance.name ?? instance.id),
          type: String(instance.type),
          enabled: instance.enabled !== false,
          apiKeyConfigured: Boolean(providerSecrets[instance.id])
        })),
        mcpServers: configs.map((config) => {
          const status = statuses?.find((item) => item.serverId === config.id)
          return {
            id: String(config.id),
            name: String(config.name ?? config.id),
            transport: String(config.transport ?? 'stdio'),
            enabled: config.enabled !== false,
            approved: deps.mcpTrust.isApproved(config as unknown as McpServerConfig),
            status: status?.status ?? (config.enabled === false ? 'disabled' : 'unknown'),
            toolCount: status?.toolCount ?? 0,
            ...(status?.error ? { error: status.error } : {})
          }
        })
      }
    }
  }
}
