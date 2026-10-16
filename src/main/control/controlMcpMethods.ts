import {
  ControlError,
  type ControlMcpAddParams,
  type ControlMcpServer,
  type ControlMethods
} from '../../shared/controlProtocol'
import { MAX_MCP_ENV_KEYS, MCP_ENV_KEY, validateMcpServerConfig } from '../../shared/mcp'
import type { McpServerConfig, McpServerStatus } from '../../shared/types'
import type { SettingsRecord } from '../ipc/settings'
import type { AppStore } from '../ipc/state'
import { storedSettings, withTimeout } from './controlStore'

export interface McpControlDependencies {
  store: AppStore
  settingsChanged: (settings: SettingsRecord) => void
  mcpStatuses: () => Promise<McpServerStatus[]>
  mcpStatusTimeoutMs?: number
  credentialStorage: () => { secure: boolean }
  mcpTrust: {
    isApproved: (config: McpServerConfig) => boolean
    approve: (configs: McpServerConfig[]) => void
    forget: (serverId: string) => void
    /** Returns settings with the server's environment replaced, encrypted. */
    withEnvironment: (
      settings: SettingsRecord,
      serverId: string,
      values: Record<string, string>
    ) => SettingsRecord
    /** Shows the server's full content in SideKick and resolves to the user's answer. */
    confirm: (config: McpServerConfig, replacing: boolean) => Promise<boolean>
  }
}

type McpHandlers = {
  [M in 'mcp.list' | 'mcp.add' | 'mcp.remove']: (
    params: ControlMethods[M]['params']
  ) => Promise<ControlMethods[M]['result']>
}

const SERVER_ID = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_ENV_VALUE_LENGTH = 32 * 1024

function storedServers(settings: SettingsRecord): McpServerConfig[] {
  return Array.isArray(settings.mcpServers)
    ? (settings.mcpServers as McpServerConfig[]).filter(
        (server) => server && typeof server === 'object' && typeof server.id === 'string'
      )
    : []
}

function describe(
  config: McpServerConfig,
  approved: boolean,
  status?: McpServerStatus
): ControlMcpServer {
  const shared = {
    id: config.id,
    name: config.name,
    transport: config.transport,
    enabled: config.enabled !== false,
    approvalMode: config.approvalMode,
    approved,
    status: status?.status ?? (config.enabled === false ? 'disabled' : 'unknown'),
    toolCount: status?.toolCount ?? 0,
    ...(status?.error ? { error: status.error } : {})
  }
  return config.transport === 'streamable-http'
    ? { ...shared, url: config.url, authentication: config.authentication }
    : {
        ...shared,
        command: config.command,
        args: config.args ?? [],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        envKeys: config.envKeys ?? []
      }
}

/** Builds a server from CLI input; refuses anything the Settings window would refuse. */
function serverFrom(params: ControlMcpAddParams): {
  config: McpServerConfig
  env: Record<string, string>
} {
  if (typeof params.id !== 'string' || !SERVER_ID.test(params.id)) {
    throw new ControlError('usage', 'A connector id is letters, digits, dashes, and underscores.')
  }
  const env = params.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new ControlError('usage', 'Environment must map names to values.')
  }
  const names = Object.keys(env)
  if (names.length > MAX_MCP_ENV_KEYS) {
    throw new ControlError(
      'invalid-value',
      `A connector takes at most ${MAX_MCP_ENV_KEYS} variables.`
    )
  }
  for (const name of names) {
    const value = env[name]
    // Never repeat a value in an error; it is usually a token.
    if (!MCP_ENV_KEY.test(name)) {
      throw new ControlError(
        'invalid-value',
        'Environment variable names are letters, digits, and underscores.'
      )
    }
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > MAX_ENV_VALUE_LENGTH ||
      value.includes('\0')
    ) {
      throw new ControlError(
        'invalid-value',
        `The value of ${name} is empty, too long, or not text.`
      )
    }
  }
  const base = {
    id: params.id,
    name: typeof params.name === 'string' && params.name.trim() ? params.name.trim() : params.id,
    approvalMode: params.approvalMode === 'reads-auto' ? 'reads-auto' : 'prompt',
    enabled: params.enabled !== false
  } as const
  let config: McpServerConfig
  if (typeof params.url === 'string' && params.command === undefined) {
    if (names.length) {
      throw new ControlError('usage', 'Environment variables apply only to local connectors.')
    }
    config = {
      ...base,
      transport: 'streamable-http',
      url: params.url,
      authentication: params.authentication === 'oauth' ? 'oauth' : 'none'
    }
  } else if (typeof params.command === 'string' && params.url === undefined) {
    if (
      params.args !== undefined &&
      (!Array.isArray(params.args) || params.args.some((arg) => typeof arg !== 'string'))
    ) {
      throw new ControlError('usage', 'Arguments must be text.')
    }
    config = {
      ...base,
      transport: 'stdio',
      command: params.command,
      args: params.args ?? [],
      ...(typeof params.cwd === 'string' && params.cwd ? { cwd: params.cwd } : {}),
      ...(names.length ? { envKeys: [...names].sort() } : {})
    }
  } else {
    throw new ControlError(
      'usage',
      'Give either a command for a local connector or a URL for a remote one.'
    )
  }
  const invalid = validateMcpServerConfig(config)
  if (invalid) throw new ControlError('invalid-value', invalid)
  return { config, env }
}

/**
 * MCP methods. Adding or replacing a server always shows its full content in SideKick, and
 * approval is recorded for exactly that content; environment values are encrypted on arrival
 * and never returned.
 */
export function createMcpControlHandlers(deps: McpControlDependencies): McpHandlers {
  const { store } = deps

  async function statuses(): Promise<McpServerStatus[] | null> {
    return withTimeout(deps.mcpStatuses(), deps.mcpStatusTimeoutMs ?? 5_000)
  }

  return {
    'mcp.list': async () => {
      const servers = storedServers(storedSettings(store))
      const current = servers.length ? await statuses() : []
      return {
        servers: servers.map((server) =>
          describe(
            server,
            deps.mcpTrust.isApproved(server),
            current?.find((status) => status.serverId === server.id)
          )
        )
      }
    },

    'mcp.add': async (params) => {
      const { config, env } = serverFrom(params)
      const before = storedSettings(store)
      const replacing = storedServers(before).some((server) => server.id === config.id)
      if (replacing && params.replace !== true) {
        throw new ControlError(
          'invalid-value',
          `A connector named ${config.id} exists. Pass --replace to change it.`
        )
      }
      if (Object.keys(env).length && !deps.credentialStorage().secure) {
        throw new ControlError(
          'storage-locked',
          'Secure credential storage is unavailable, so environment values cannot be stored.'
        )
      }
      if (!(await deps.mcpTrust.confirm(config, replacing))) {
        throw new ControlError('denied', 'The connector was declined in SideKick.')
      }
      // The dialog can stay open for a while; apply the change to what is stored now.
      const current = storedSettings(store)
      const servers = storedServers(current)
      const index = servers.findIndex((server) => server.id === config.id)
      const nextServers =
        index === -1
          ? [...servers, config]
          : servers.map((server, at) => (at === index ? config : server))
      let next: SettingsRecord
      try {
        next = deps.mcpTrust.withEnvironment(
          { ...current, mcpServers: nextServers },
          config.id,
          env
        )
      } catch {
        throw new ControlError(
          'storage-locked',
          'Secure credential storage could not encrypt the environment values.'
        )
      }
      store.set('settings', next)
      deps.mcpTrust.approve([config])
      deps.settingsChanged(next)
      return { server: describe(config, true), replaced: index !== -1 }
    },

    'mcp.remove': async ({ id }) => {
      if (typeof id !== 'string' || !SERVER_ID.test(id)) {
        throw new ControlError('usage', 'Name the connector id from `sidekick mcp list`.')
      }
      const current = storedSettings(store)
      const servers = storedServers(current)
      if (!servers.some((server) => server.id === id)) {
        throw new ControlError('not-found', `No connector named ${id}. Run \`sidekick mcp list\`.`)
      }
      const next = deps.mcpTrust.withEnvironment(
        { ...current, mcpServers: servers.filter((server) => server.id !== id) },
        id,
        {}
      )
      store.set('settings', next)
      deps.mcpTrust.forget(id)
      deps.settingsChanged(next)
      return { id, removed: true }
    }
  }
}
