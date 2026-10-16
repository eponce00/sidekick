/**
 * What makes an MCP server trusted: the user approved its exact content. Approval is recorded as
 * a fingerprint of everything that decides what runs or where requests go (command, arguments,
 * working directory, environment, URL, authentication, read auto-approval), never its name, so
 * an edited server is asked about again however it was edited.
 */
import { createHash } from 'node:crypto'
import { safeStorage } from 'electron'
import type { McpServerConfig } from '../../shared/types'
import type { McpServerTrust } from './mcpClientManager'
import { getStore } from '../ipc/state'
import { isSecureCredentialStorageAvailable } from './secureCredentialStorage'

const APPROVALS_KEY = 'mcpApprovals'
export const MCP_ENV_SECRETS_KEY = '__encryptedMcpEnv'

type EncryptedMcpEnvironment = Record<string, Record<string, string>>

interface ApprovalRecord {
  version: 1
  fingerprints: Record<string, string>
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function storedSettings(): Record<string, unknown> {
  const value = getStore().get('settings', {})
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function encryptedEnvironment(settings: Record<string, unknown>): EncryptedMcpEnvironment {
  const value = settings[MCP_ENV_SECRETS_KEY]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as EncryptedMcpEnvironment)
    : {}
}

/**
 * Keeps encrypted server environments only for servers and names that still exist. Values come
 * from the stored record alone, so a settings save can never plant one.
 */
export function retainedMcpEnvironment(
  existing: Record<string, unknown> | undefined,
  servers: unknown
): EncryptedMcpEnvironment {
  const previous = existing ? encryptedEnvironment(existing) : {}
  const retained: EncryptedMcpEnvironment = {}
  if (!Array.isArray(servers)) return retained
  for (const raw of servers) {
    const server = raw as { id?: unknown; envKeys?: unknown }
    if (!server || typeof server.id !== 'string' || !Array.isArray(server.envKeys)) continue
    const values = previous[server.id]
    if (!values) continue
    const names = server.envKeys as unknown[]
    const kept = Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
    if (Object.keys(kept).length) retained[server.id] = kept
  }
  return retained
}

/** Returns settings with one server's environment replaced by `values`, encrypted. */
export function withMcpEnvironment(
  settings: Record<string, unknown>,
  serverId: string,
  values: Record<string, string>
): Record<string, unknown> {
  const all = { ...encryptedEnvironment(settings) }
  if (Object.keys(values).length) {
    if (!isSecureCredentialStorageAvailable()) {
      throw new Error('Secure credential storage is unavailable.')
    }
    all[serverId] = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        safeStorage.encryptString(value).toString('base64')
      ])
    )
  } else {
    delete all[serverId]
  }
  return { ...settings, [MCP_ENV_SECRETS_KEY]: all }
}

/** The decrypted environment a stdio server starts with. Main process only. */
export function mcpServerEnvironment(config: McpServerConfig): Record<string, string> {
  if (config.transport !== 'stdio' || !config.envKeys?.length) return {}
  const values = encryptedEnvironment(storedSettings())[config.id] ?? {}
  const environment: Record<string, string> = {}
  for (const name of config.envKeys) {
    if (!values[name]) continue
    environment[name] = safeStorage.decryptString(Buffer.from(values[name], 'base64'))
  }
  return environment
}

/**
 * Fingerprints a server's content. Environment values enter only as hashes of their encrypted
 * form, so the fingerprint changes when a value is replaced without ever holding the value.
 */
export function mcpServerFingerprint(
  config: McpServerConfig,
  settings: Record<string, unknown> = storedSettings()
): string {
  const environment = encryptedEnvironment(settings)[config.id] ?? {}
  const content =
    config.transport === 'stdio'
      ? {
          transport: 'stdio',
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd ?? '',
          env: [...(config.envKeys ?? [])]
            .sort()
            .map((name) => [name, sha256(environment[name] ?? '')]),
          approvalMode: config.approvalMode
        }
      : {
          transport: 'streamable-http',
          url: config.url,
          authentication: config.authentication,
          catalogId: config.catalogId ?? '',
          approvalMode: config.approvalMode
        }
  return sha256(JSON.stringify(content))
}

function approvals(): ApprovalRecord | null {
  const value = getStore().get(APPROVALS_KEY)
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ApprovalRecord>
  return record.version === 1 && record.fingerprints && typeof record.fingerprints === 'object'
    ? (record as ApprovalRecord)
    : null
}

export function isMcpServerApproved(config: McpServerConfig): boolean {
  return approvals()?.fingerprints[config.id] === mcpServerFingerprint(config)
}

export function approveMcpServers(configs: McpServerConfig[]): void {
  const settings = storedSettings()
  const fingerprints = { ...(approvals()?.fingerprints ?? {}) }
  for (const config of configs) fingerprints[config.id] = mcpServerFingerprint(config, settings)
  getStore().set(APPROVALS_KEY, { version: 1, fingerprints })
}

export function forgetMcpServerApproval(serverId: string): void {
  const fingerprints = { ...(approvals()?.fingerprints ?? {}) }
  delete fingerprints[serverId]
  getStore().set(APPROVALS_KEY, { version: 1, fingerprints })
}

function storedServers(): McpServerConfig[] {
  const servers = storedSettings().mcpServers
  return Array.isArray(servers)
    ? servers.filter(
        (server): server is McpServerConfig =>
          Boolean(server) && typeof (server as McpServerConfig).id === 'string'
      )
    : []
}

/**
 * Servers configured before approval was content-bound were approved through the old Settings
 * dialog; record them once so upgrading does not switch every connector off.
 */
export function seedMcpApprovals(): void {
  if (!approvals()) approveMcpServers(storedServers())
}

/** Servers in `next` that are new or whose content differs from `previous`. */
export function changedMcpServers(previous: unknown, next: unknown): McpServerConfig[] {
  const settings = storedSettings()
  const before = new Map(
    (Array.isArray(previous) ? (previous as McpServerConfig[]) : [])
      .filter((server) => server && typeof server.id === 'string')
      .map((server) => [server.id, mcpServerFingerprint(server, settings)])
  )
  return (Array.isArray(next) ? (next as McpServerConfig[]) : []).filter(
    (server) =>
      server &&
      typeof server.id === 'string' &&
      before.get(server.id) !== mcpServerFingerprint(server, settings)
  )
}

/** The policy every MCP client manager in the running app uses. */
export const mainProcessMcpTrust: McpServerTrust = {
  isApproved: isMcpServerApproved,
  // Any change to the stored config or to an encrypted value restarts the server.
  identity: (config) => `${mcpServerFingerprint(config)}:${JSON.stringify(config)}`,
  environment: mcpServerEnvironment
}
