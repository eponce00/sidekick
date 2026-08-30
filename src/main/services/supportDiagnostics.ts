import type { SupportDiagnostics } from '../../shared/supportDiagnostics'
import { SUPPORT_DIAGNOSTICS_SCHEMA_VERSION } from '../../shared/supportDiagnostics'
import { normalizePermissionMode } from '../../shared/permissions'

const KNOWN_PERMISSION_MODES = new Set([
  'always-ask',
  'sensitive-only',
  'full-access',
  'agent-decides',
  'bypass'
])

const PROVIDER_TYPES = [
  'ollama',
  'ollama-cloud',
  'openrouter',
  'anthropic',
  'litellm',
  'openai-compatible',
  'llamacpp'
] as const

interface SupportDiagnosticsInput {
  generatedAt: Date
  application: SupportDiagnostics['application']
  system: SupportDiagnostics['system']
  protectedCredentialStorageAvailable: boolean
  databaseOpen: boolean
  settings: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function summarizeProviders(
  settings: Record<string, unknown>
): SupportDiagnostics['configuration']['providers'] {
  const instances = Array.isArray(settings.providerInstances) ? settings.providerInstances : []
  const byType = Object.fromEntries(PROVIDER_TYPES.map((type) => [type, 0]))
  let enabled = 0
  let unknown = 0

  for (const value of instances) {
    const instance = record(value)
    if (!instance) {
      unknown += 1
      continue
    }
    if (instance.enabled !== false) enabled += 1
    const type = typeof instance.type === 'string' ? instance.type : ''
    if (Object.hasOwn(byType, type)) byType[type] += 1
    else unknown += 1
  }

  if (unknown > 0) byType.unknown = unknown
  return { total: instances.length, enabled, byType }
}

function summarizeConnectors(
  settings: Record<string, unknown>
): SupportDiagnostics['configuration']['connectors'] {
  const connectors = Array.isArray(settings.mcpServers) ? settings.mcpServers : []
  let enabled = 0
  let local = 0
  let remote = 0
  let oauth = 0

  for (const value of connectors) {
    const connector = record(value)
    if (!connector) continue
    if (connector.enabled !== false) enabled += 1
    if (connector.transport === 'stdio') local += 1
    if (connector.transport === 'streamable-http') remote += 1
    if (connector.authentication === 'oauth') oauth += 1
  }

  return { total: connectors.length, enabled, local, remote, oauth }
}

export function createSupportDiagnostics(input: SupportDiagnosticsInput): SupportDiagnostics {
  const settings = record(input.settings) ?? {}
  const rawPermissionMode = settings.commandPermissionMode
  const permissionMode =
    rawPermissionMode === undefined
      ? 'full-access'
      : typeof rawPermissionMode === 'string' && KNOWN_PERMISSION_MODES.has(rawPermissionMode)
        ? normalizePermissionMode(rawPermissionMode)
        : 'unknown'

  return {
    schemaVersion: SUPPORT_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    application: input.application,
    system: input.system,
    security: {
      protectedCredentialStorageAvailable: input.protectedCredentialStorageAvailable,
      rendererSandboxed: true
    },
    storage: { databaseOpen: input.databaseOpen },
    configuration: {
      permissionMode,
      providers: summarizeProviders(settings),
      connectors: summarizeConnectors(settings)
    },
    privacy: {
      contentIncluded: false,
      credentialsIncluded: false,
      endpointsIncluded: false,
      pathsIncluded: false,
      logsIncluded: false
    }
  }
}
