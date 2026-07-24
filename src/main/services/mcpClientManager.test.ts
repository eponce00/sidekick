import { describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolInfo
} from '../../shared/types'
import { McpClientManager, type McpConnectionAdapter } from './mcpClientManager'
import { mcpFunctionName } from './agentToolRuntime'
import { ConnectorCredentialStore } from './connectorCredentialStore'
import { McpOAuthSessionStore } from './mcpOAuth'

function config(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    id: 'server-one',
    name: 'Server one',
    transport: 'stdio',
    command: 'fake-server',
    approvalMode: 'prompt',
    enabled: true,
    ...overrides
  }
}

function tool(server: McpServerConfig, name = 'lookup'): McpToolInfo {
  return {
    serverId: server.id,
    serverName: server.name,
    name,
    inputSchema: { type: 'object', properties: {} },
    approvalMode: server.approvalMode
  }
}

function adapter(overrides: Partial<McpConnectionAdapter> = {}): McpConnectionAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ ok: true })),
    ...overrides
  }
}

function oauthSessions(): McpOAuthSessionStore {
  let persisted: Record<string, string> = {}
  return new McpOAuthSessionStore(
    new ConnectorCredentialStore(
      {
        isAvailable: () => true,
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => Buffer.from(value).toString()
      },
      {
        read: () => ({ ...persisted }),
        write: (next) => {
          persisted = { ...next }
        }
      }
    )
  )
}

describe('McpClientManager lifecycle invariants', () => {
  it('forgets failures after a server is removed instead of showing a permanent ghost status', async () => {
    const broken = adapter({
      connect: vi.fn(async () => Promise.reject(new Error('spawn failed')))
    })
    const manager = new McpClientManager(() => broken)

    await manager.sync([config({ name: 'Broken server' })])
    await expect(manager.listTools()).resolves.toMatchObject({
      tools: [],
      statuses: [
        {
          serverId: 'server-one',
          serverName: 'Broken server',
          status: 'error',
          error: 'spawn failed'
        }
      ]
    })

    await manager.sync([])
    await expect(manager.listTools()).resolves.toEqual({ tools: [], statuses: [] })
    expect(broken.close).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent configuration changes and closes the superseded connection', async () => {
    let releaseFirst!: () => void
    const firstConnected = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = adapter({ connect: vi.fn(() => firstConnected) })
    const secondConfig = config({ command: 'replacement-server' })
    const second = adapter({ listTools: vi.fn(async () => ({ tools: [tool(secondConfig)] })) })
    const created: McpConnectionAdapter[] = []
    const manager = new McpClientManager(() => {
      const next = created.length === 0 ? first : second
      created.push(next)
      return next
    })

    const initialSync = manager.sync([config()])
    const replacementSync = manager.sync([secondConfig])
    await Promise.resolve()
    expect(created).toEqual([first])
    releaseFirst()
    await Promise.all([initialSync, replacementSync])

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(created).toEqual([first, second])
    await expect(manager.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ serverId: 'server-one', name: 'lookup' })],
      statuses: [expect.objectContaining({ status: 'connected', toolCount: 1 })]
    })
  })

  it('evicts a connection whose tool listing fails so the next sync can reconnect', async () => {
    const server = config()
    const failed = adapter({
      listTools: vi.fn(async () => Promise.reject(new Error('pipe closed')))
    })
    const recovered = adapter({ listTools: vi.fn(async () => ({ tools: [tool(server)] })) })
    const created = [failed, recovered]
    const manager = new McpClientManager(() => created.shift()!)

    await manager.sync([server])
    await expect(manager.listTools()).resolves.toMatchObject({
      tools: [],
      statuses: [expect.objectContaining({ status: 'error', error: 'pipe closed' })]
    })
    expect(failed.close).toHaveBeenCalledTimes(1)

    await manager.sync([server])
    await expect(manager.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'lookup' })],
      statuses: [expect.objectContaining({ status: 'connected' })]
    })
  })

  it('bounds and cancels hung MCP tool calls', async () => {
    const hanging = adapter({ callTool: vi.fn(() => new Promise(() => undefined)) })
    const manager = new McpClientManager(() => hanging)
    await manager.sync([config()])

    await expect(manager.callTool('server-one', 'hang', {}, { timeoutMs: 10 })).rejects.toThrow(
      'timed out after 10ms'
    )

    const controller = new AbortController()
    const cancelled = manager.callTool('server-one', 'hang', {}, { signal: controller.signal })
    controller.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
  })

  it('rejects duplicate server identities before launching either process', async () => {
    const factory = vi.fn(() => adapter())
    const manager = new McpClientManager(factory)

    await expect(
      manager.sync([config(), config({ name: 'Duplicate name', command: 'other-command' })])
    ).rejects.toThrow('Duplicate MCP server id: server-one')
    expect(factory).not.toHaveBeenCalled()
  })

  it('reports disabled connectors without launching them', async () => {
    const factory = vi.fn(() => adapter())
    const manager = new McpClientManager(factory)

    await manager.sync([config({ enabled: false })])

    expect(factory).not.toHaveBeenCalled()
    await expect(manager.listTools()).resolves.toEqual({
      tools: [],
      statuses: [
        {
          serverId: 'server-one',
          serverName: 'Server one',
          status: 'disabled',
          toolCount: 0
        }
      ]
    })
  })

  it('surfaces authentication-required connections as a distinct lifecycle state', async () => {
    const unauthorized = new Error('Authorization required')
    unauthorized.name = 'UnauthorizedError'
    const manager = new McpClientManager(() =>
      adapter({ connect: vi.fn(async () => Promise.reject(unauthorized)) })
    )

    await manager.sync([config()])

    await expect(manager.listTools()).resolves.toMatchObject({
      statuses: [expect.objectContaining({ status: 'needs_auth' })]
    })
  })

  it('completes an explicit OAuth callback before connecting the server', async () => {
    const remote: McpHttpServerConfig = {
      id: 'remote',
      name: 'Remote connector',
      transport: 'streamable-http',
      url: 'https://connect.example.com/mcp',
      authentication: 'oauth',
      approvalMode: 'prompt',
      enabled: true
    }
    let connectCount = 0
    const finishAuth = vi.fn(async () => undefined)
    const manager = new McpClientManager(
      (_config, options) =>
        adapter({
          connect: vi.fn(async () => {
            connectCount += 1
            if (connectCount > 1) return
            const provider = options?.authProvider
            if (!provider?.redirectUrl || !provider.state) throw new Error('Missing OAuth provider')
            const state = await provider.state()
            void fetch(
              `${provider.redirectUrl}?state=${encodeURIComponent(state)}&code=authorization-code`
            )
            throw new UnauthorizedError()
          }),
          finishAuth
        }),
      () => oauthSessions(),
      vi.fn(async () => undefined)
    )

    await manager.sync([remote])
    await manager.authenticate(remote.id)

    expect(finishAuth).toHaveBeenCalledWith('authorization-code')
    await expect(manager.listTools()).resolves.toMatchObject({
      statuses: [expect.objectContaining({ status: 'connected' })]
    })
  })
})

describe('MCP provider tool identities', () => {
  it('remain valid, bounded, stable, and collision-resistant after provider-name normalization', () => {
    const spaced = mcpFunctionName({ serverId: 'team server', name: 'files/read' })
    const underscored = mcpFunctionName({ serverId: 'team_server', name: 'files_read' })

    expect(spaced).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(spaced.length).toBeLessThanOrEqual(64)
    expect(spaced).toBe(mcpFunctionName({ serverId: 'team server', name: 'files/read' }))
    expect(spaced).not.toBe(underscored)
  })
})
