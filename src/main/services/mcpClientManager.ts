import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  UnauthorizedError,
  type OAuthClientProvider
} from '@modelcontextprotocol/sdk/client/auth.js'
import { shell } from 'electron'
import { validateMcpServerConfig } from '../../shared/mcp'
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
  McpToolInfo
} from '../../shared/types'
import packageMetadata from '../../../package.json'
import { createConnectorCredentialStore } from './connectorCredentialStore'
import { createMcpOAuthCallback, McpOAuthSessionStore } from './mcpOAuth'

export interface McpConnectionAdapter {
  connect(): Promise<void>
  close(): Promise<void>
  listTools(): Promise<{ tools: McpToolInfo[] }>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  finishAuth?(authorizationCode: string): Promise<void>
}

export interface McpConnectionOptions {
  authProvider?: OAuthClientProvider
}

export type McpConnectionFactory = (
  config: McpServerConfig,
  options?: McpConnectionOptions
) => McpConnectionAdapter

interface Connection {
  config: McpServerConfig
  adapter: McpConnectionAdapter
}

interface ConnectionFailure {
  config: McpServerConfig
  error: string
  status: Extract<McpServerStatus['status'], 'needs_auth' | 'error'>
}

export interface McpCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

const CONNECT_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 3_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function failureStatus(error: unknown): ConnectionFailure['status'] {
  return error instanceof UnauthorizedError ||
    (error instanceof Error && error.name === 'UnauthorizedError')
    ? 'needs_auth'
    : 'error'
}

function withDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled`))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => finish(() => reject(new Error(`${label} cancelled`)))
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`))),
      timeoutMs
    )
    signal?.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

function mapTools(client: Client, config: McpServerConfig): McpConnectionAdapter['listTools'] {
  return async () => {
    const page = await client.listTools()
    return {
      tools: page.tools.map((tool) => ({
        serverId: config.id,
        serverName: config.name,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        annotations: tool.annotations,
        approvalMode: config.approvalMode ?? 'prompt'
      }))
    }
  }
}

function stdioConnection(config: McpStdioServerConfig): McpConnectionAdapter {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    stderr: 'pipe'
  })
  const client = new Client({ name: 'sidekick-desktop', version: packageMetadata.version })
  return {
    connect: () => client.connect(transport),
    close: async () => {
      await Promise.allSettled([client.close(), transport.close()])
    },
    listTools: mapTools(client, config),
    callTool: (name, args) => client.callTool({ name, arguments: args })
  }
}

function streamableHttpConnection(
  config: McpHttpServerConfig,
  options: McpConnectionOptions
): McpConnectionAdapter {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider: options.authProvider,
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 3
    }
  })
  const client = new Client({ name: 'sidekick-desktop', version: packageMetadata.version })
  return {
    connect: () => client.connect(transport),
    close: async () => {
      await Promise.allSettled([client.close(), transport.close()])
    },
    listTools: mapTools(client, config),
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    finishAuth: (authorizationCode) => transport.finishAuth(authorizationCode)
  }
}

export function createMcpConnection(
  config: McpServerConfig,
  options: McpConnectionOptions = {}
): McpConnectionAdapter {
  const validationError = validateMcpServerConfig(config)
  if (validationError) throw new Error(`${config.name}: ${validationError}`)
  return config.transport === 'streamable-http'
    ? streamableHttpConnection(config, options)
    : stdioConnection(config)
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>()
  private readonly connectionErrors = new Map<string, ConnectionFailure>()
  private configs = new Map<string, McpServerConfig>()
  private syncQueue: Promise<void> = Promise.resolve()
  private oauthSessions?: McpOAuthSessionStore

  constructor(
    private readonly createConnection: McpConnectionFactory = createMcpConnection,
    private readonly createOAuthSessions: () => McpOAuthSessionStore = () =>
      new McpOAuthSessionStore(createConnectorCredentialStore()),
    private readonly openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url)
  ) {}

  private oauth(): McpOAuthSessionStore {
    this.oauthSessions ??= this.createOAuthSessions()
    return this.oauthSessions
  }

  sync(configs: McpServerConfig[]): Promise<void> {
    const operation = this.syncQueue.then(() => this.syncNow(configs))
    this.syncQueue = operation.catch(() => undefined)
    return operation
  }

  private async syncNow(configs: McpServerConfig[]): Promise<void> {
    const ids = new Set<string>()
    for (const config of configs) {
      if (ids.has(config.id)) throw new Error(`Duplicate MCP server id: ${config.id}`)
      ids.add(config.id)
      const validationError = validateMcpServerConfig(config)
      if (config.enabled !== false && validationError) {
        throw new Error(`${config.name || config.id}: ${validationError}`)
      }
    }
    this.configs = new Map(configs.map((config) => [config.id, config]))
    const enabled = new Map(
      configs.filter((config) => config.enabled !== false).map((config) => [config.id, config])
    )
    for (const id of this.connectionErrors.keys()) {
      if (!enabled.has(id)) this.connectionErrors.delete(id)
    }
    for (const [id, connection] of this.connections) {
      const next = enabled.get(id)
      if (!next || !sameConfig(next, connection.config)) {
        await this.closeConnection(connection.adapter)
        this.connections.delete(id)
      }
    }
    for (const config of enabled.values()) {
      if (this.connections.has(config.id)) continue
      let authProvider: OAuthClientProvider | undefined
      if (config.transport === 'streamable-http' && config.authentication === 'oauth') {
        authProvider = await this.oauth().providerForExistingSession(config)
        if (!authProvider) {
          this.connectionErrors.set(config.id, {
            config,
            error: 'OAuth sign-in is required.',
            status: 'needs_auth'
          })
          continue
        }
      }
      const adapter = this.createConnection(config, { authProvider })
      try {
        await withDeadline(
          adapter.connect(),
          `Connecting to MCP server ${config.name}`,
          CONNECT_TIMEOUT_MS
        )
        this.connections.set(config.id, { config, adapter })
        this.connectionErrors.delete(config.id)
      } catch (error) {
        this.connectionErrors.set(config.id, {
          config,
          error: errorMessage(error),
          status: failureStatus(error)
        })
        await this.closeConnection(adapter)
      }
    }
  }

  async authenticate(serverId: string): Promise<void> {
    await this.syncQueue
    const config = this.configs.get(serverId)
    if (!config) throw new Error(`Unknown MCP connector: ${serverId}`)
    if (config.transport !== 'streamable-http' || config.authentication !== 'oauth') {
      throw new Error(`MCP connector ${config.name} does not use OAuth.`)
    }
    const existing = this.connections.get(serverId)
    if (existing) {
      await this.closeConnection(existing.adapter)
      this.connections.delete(serverId)
    }
    const callback = await createMcpOAuthCallback()
    const provider = await this.oauth().providerForInteractiveSession(
      config,
      callback,
      async (authorizationUrl) => {
        await this.openExternal(authorizationUrl.toString())
      }
    )
    const adapter = this.createConnection(config, { authProvider: provider })
    try {
      try {
        await withDeadline(
          adapter.connect(),
          `Starting OAuth for ${config.name}`,
          CONNECT_TIMEOUT_MS
        )
      } catch (error) {
        if (failureStatus(error) !== 'needs_auth') throw error
        if (!adapter.finishAuth)
          throw new Error('OAuth is not supported by this connector transport.')
        const authorizationCode = await callback.waitForCode()
        await withDeadline(
          adapter.finishAuth(authorizationCode),
          `Completing OAuth for ${config.name}`,
          CONNECT_TIMEOUT_MS
        )
        await withDeadline(
          adapter.connect(),
          `Connecting to MCP server ${config.name}`,
          CONNECT_TIMEOUT_MS
        )
      }
      this.connections.set(serverId, { config, adapter })
      this.connectionErrors.delete(serverId)
    } catch (error) {
      this.connectionErrors.set(serverId, {
        config,
        error: errorMessage(error),
        status: 'needs_auth'
      })
      await this.closeConnection(adapter)
      throw error
    } finally {
      await callback.close()
    }
  }

  async disconnect(serverId: string): Promise<void> {
    await this.syncQueue
    const connection = this.connections.get(serverId)
    if (connection) {
      await this.closeConnection(connection.adapter)
      this.connections.delete(serverId)
    }
    await this.oauth().disconnect(serverId)
    const config = this.configs.get(serverId)
    if (config) {
      this.connectionErrors.set(serverId, {
        config,
        error: 'OAuth sign-in is required.',
        status: 'needs_auth'
      })
    }
  }

  async listTools(): Promise<{ tools: McpToolInfo[]; statuses: McpServerStatus[] }> {
    await this.syncQueue
    const tools: McpToolInfo[] = []
    const statuses: McpServerStatus[] = []
    for (const [serverId, connection] of [...this.connections]) {
      try {
        const page = await withDeadline(
          connection.adapter.listTools(),
          `Listing tools from MCP server ${connection.config.name}`,
          LIST_TIMEOUT_MS
        )
        statuses.push({
          serverId,
          serverName: connection.config.name,
          status: 'connected',
          toolCount: page.tools.length
        })
        tools.push(...page.tools)
      } catch (error) {
        const message = errorMessage(error)
        statuses.push({
          serverId,
          serverName: connection.config.name,
          status: 'error',
          toolCount: 0,
          error: message
        })
        this.connections.delete(serverId)
        this.connectionErrors.set(serverId, {
          config: connection.config,
          error: message,
          status: failureStatus(error)
        })
        await this.closeConnection(connection.adapter)
      }
    }
    for (const [serverId, failure] of this.connectionErrors) {
      if (statuses.some((status) => status.serverId === serverId)) continue
      statuses.push({
        serverId,
        serverName: failure.config.name,
        status: failure.status,
        toolCount: 0,
        error: failure.error
      })
    }
    for (const [serverId, config] of this.configs) {
      if (config.enabled !== false || statuses.some((status) => status.serverId === serverId))
        continue
      statuses.push({
        serverId,
        serverName: config.name,
        status: 'disabled',
        toolCount: 0
      })
    }
    return { tools, statuses }
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {}
  ): Promise<unknown> {
    await this.syncQueue
    const connection = this.connections.get(serverId)
    if (!connection) throw new Error(`MCP server is not connected: ${serverId}`)
    return withDeadline(
      connection.adapter.callTool(name, args),
      `MCP tool ${connection.config.name}/${name}`,
      Math.max(1, Math.min(options.timeoutMs ?? CALL_TIMEOUT_MS, CALL_TIMEOUT_MS)),
      options.signal
    )
  }

  private async closeConnection(adapter: McpConnectionAdapter): Promise<void> {
    await withDeadline(adapter.close(), 'Closing MCP server', CLOSE_TIMEOUT_MS).catch(
      () => undefined
    )
  }

  async close(): Promise<void> {
    await this.syncQueue.catch(() => undefined)
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.closeConnection(connection.adapter))
    )
    this.connections.clear()
    this.connectionErrors.clear()
    this.configs.clear()
  }
}
