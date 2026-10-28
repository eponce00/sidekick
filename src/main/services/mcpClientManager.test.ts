import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolInfo
} from '../../shared/types'
import { registerMcpToolHandlers } from './agentMcpToolHandlers'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import {
  createMcpConnection,
  McpClientManager,
  type McpConnectionAdapter
} from './mcpClientManager'
import { mcpFunctionName } from './agentToolRuntime'
import { ConnectorCredentialStore } from './connectorCredentialStore'
import { McpOAuthSessionStore } from './mcpOAuth'
import { ToolOutputStore } from './toolOutputStore'

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
    isOpen: vi.fn(() => true),
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

describe('McpClientManager content-bound approval', () => {
  function trust(approved: Set<string>) {
    return {
      isApproved: (server: McpServerConfig) => approved.has(JSON.stringify(server)),
      identity: (server: McpServerConfig) => JSON.stringify(server),
      environment: () => ({ TOKEN: 'decrypted-value' })
    }
  }

  it('never starts a server whose current content was not approved', async () => {
    const factory = vi.fn(() => adapter())
    const manager = new McpClientManager(factory, undefined, undefined, trust(new Set()))
    await manager.sync([config()])
    expect(factory).not.toHaveBeenCalled()
    await expect(manager.listTools()).resolves.toMatchObject({
      statuses: [{ serverId: 'server-one', status: 'needs_approval' }]
    })
  })

  it('stops a running server when its content changes, and waits for approval again', async () => {
    const original = config()
    const running = adapter()
    const factory = vi.fn(() => running)
    const approved = new Set([JSON.stringify(original)])
    const manager = new McpClientManager(factory, undefined, undefined, trust(approved))
    await manager.sync([original])
    expect(factory).toHaveBeenCalledTimes(1)

    await manager.sync([config({ args: ['--evil'] })])
    expect(running.close).toHaveBeenCalled()
    expect(factory).toHaveBeenCalledTimes(1)
    await expect(manager.listTools()).resolves.toMatchObject({
      statuses: [{ serverId: 'server-one', status: 'needs_approval' }]
    })
  })

  it('stops a running server whose approval was withdrawn', async () => {
    const original = config()
    const running = adapter()
    const approved = new Set([JSON.stringify(original)])
    const manager = new McpClientManager(() => running, undefined, undefined, trust(approved))
    await manager.sync([original])
    approved.clear()
    await manager.sync([original])
    expect(running.close).toHaveBeenCalled()
  })

  it('hands the decrypted environment to the connection only', async () => {
    const original = config({ envKeys: ['TOKEN'] })
    const factory = vi.fn(() => adapter())
    const manager = new McpClientManager(
      factory,
      undefined,
      undefined,
      trust(new Set([JSON.stringify(original)]))
    )
    await manager.sync([original])
    expect(factory).toHaveBeenCalledWith(original, {
      authProvider: undefined,
      environment: { TOKEN: 'decrypted-value' }
    })
    const listed = await manager.listTools()
    expect(JSON.stringify(listed)).not.toContain('decrypted-value')
  })
})

/** A local MCP server speaking the stdio protocol, so the SDK client runs for real. */
const STDIO_SERVER = String.raw`
const fs = require('fs')
let cancellations = 0
let buffer = ''
const send = (message) => fs.writeSync(1, JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const text = (value, isError) => ({ content: [{ type: 'text', text: String(value) }], isError })
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const { id, method, params } = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (method === 'notifications/cancelled') cancellations += 1
    if (id === undefined) continue
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' } } })
    } else if (method === 'tools/list') {
      const tool = (name) => ({ name, inputSchema: { type: 'object' } })
      send({ id, result: params && params.cursor ? { tools: [tool('second')] }
        : { tools: [tool('first')], nextCursor: 'page-2' } })
    } else if (params.name === 'noisy') {
      fs.writeSync(2, 'log line\n'.repeat(200000))
      send({ id, result: text('done') })
    } else if (params.name === 'exit') {
      process.exit(0)
    } else if (params.name === 'fail') {
      send({ id, result: text('Repository not found', true) })
    } else if (params.name === 'cancellations') {
      send({ id, result: text(cancellations) })
    }
  }
})
`

describe('McpClientManager with a local stdio server', () => {
  let root: string
  let server: McpStdioServerConfig
  const managers: McpClientManager[] = []

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'sidekick-mcp-stdio-'))
    await fs.writeFile(join(root, 'server.cjs'), STDIO_SERVER)
    server = config({ command: process.execPath, args: [join(root, 'server.cjs')] })
  })

  afterAll(async () => {
    await Promise.all(managers.map((manager) => manager.close()))
    await fs.rm(root, { recursive: true, force: true })
  })

  async function connected(): Promise<McpClientManager> {
    // Tests run under Electron's Node; the server must too.
    const manager = new McpClientManager((next) =>
      createMcpConnection(next, { environment: { ELECTRON_RUN_AS_NODE: '1' } })
    )
    managers.push(manager)
    await manager.sync([server])
    return manager
  }

  async function answer(manager: McpClientManager, name: string): Promise<string> {
    const result = await manager.callTool(server.id, name, {}, { timeoutMs: 5_000 })
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  const bothPages = {
    tools: [expect.objectContaining({ name: 'first' }), expect.objectContaining({ name: 'second' })]
  }

  it('lists every page of tools and keeps answering a server that logs a lot', async () => {
    const manager = await connected()
    await expect(manager.listTools()).resolves.toMatchObject(bothPages)
    expect(await answer(manager, 'noisy')).toBe('done')
    expect(await answer(manager, 'noisy')).toBe('done')
  })

  it('cancels the call on the server when the run stops', async () => {
    const manager = await connected()
    const controller = new AbortController()
    const hung = manager.callTool(server.id, 'hang', {}, { signal: controller.signal })
    // The server reads requests in order, so this answer means it has the hung call.
    expect(await answer(manager, 'cancellations')).toBe('0')
    controller.abort()
    await expect(hung).rejects.toThrow('cancelled')
    expect(await answer(manager, 'cancellations')).toBe('1')
  })

  it('starts a server again after it exits', async () => {
    const manager = await connected()
    await expect(answer(manager, 'exit')).rejects.toThrow()
    await manager.sync([server])
    await expect(manager.listTools()).resolves.toMatchObject(bothPages)
  })

  it("records a result flagged isError as a failed tool call with the server's text", async () => {
    const manager = await connected()
    const listed = await manager.listTools()
    const registry = new AgentToolHandlerRegistry()
    registerMcpToolHandlers(registry, {
      mcp: manager,
      available: new Map([['fail', { ...listed.tools[0], name: 'fail' }]]),
      enabled: new Map(),
      readReceipts: new Map(),
      outputs: new ToolOutputStore(root)
    })
    const result = await registry.execute({
      name: 'fail',
      title: 'fail',
      arguments: {},
      context: { runId: 'run', signal: new AbortController().signal }
    })
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'command_failed', message: 'Repository not found' }
    })
  })
})
