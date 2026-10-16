import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlError } from '../../shared/controlProtocol'
import type { McpServerConfig } from '../../shared/types'
import { createMcpControlHandlers, type McpControlDependencies } from './controlMcpMethods'

const SECRET = 'ghp_SECRETVALUE123'

const existing: McpServerConfig = {
  id: 'files',
  name: 'Files',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-files'],
  envKeys: ['TOKEN'],
  approvalMode: 'prompt',
  enabled: true
}

let stored: Record<string, unknown>
let deps: McpControlDependencies & {
  mcpTrust: { [K in keyof McpControlDependencies['mcpTrust']]: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  stored = { mcpServers: [existing], __encryptedMcpEnv: { files: { TOKEN: 'ENCRYPTED' } } }
  deps = {
    store: {
      get: vi.fn((key: string, fallback?: unknown) => (key === 'settings' ? stored : fallback)),
      set: vi.fn((_key: string, value: unknown) => {
        stored = value as Record<string, unknown>
      })
    },
    settingsChanged: vi.fn(),
    credentialStorage: vi.fn(() => ({ secure: true })),
    mcpStatuses: vi.fn(async () => [
      { serverId: 'files', serverName: 'Files', status: 'connected' as const, toolCount: 2 }
    ]),
    mcpTrust: {
      isApproved: vi.fn(() => false),
      approve: vi.fn(),
      forget: vi.fn(),
      withEnvironment: vi.fn((settings, id, values) => ({
        ...settings,
        __encryptedMcpEnv: {
          ...(settings.__encryptedMcpEnv as object),
          [id]: Object.fromEntries(Object.keys(values).map((name) => [name, 'ENCRYPTED']))
        }
      })),
      confirm: vi.fn(async () => true)
    }
  } as unknown as typeof deps
})

const handlers = (): ReturnType<typeof createMcpControlHandlers> => createMcpControlHandlers(deps)

async function rejection(promise: Promise<unknown>): Promise<ControlError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ControlError)
  return error as ControlError
}

describe('mcp.list', () => {
  it('reports content, approval, and health but never environment values', async () => {
    const result = await handlers()['mcp.list']({})
    expect(result.servers).toEqual([
      expect.objectContaining({
        id: 'files',
        command: 'npx',
        args: ['-y', 'server-files'],
        envKeys: ['TOKEN'],
        approved: false,
        status: 'connected',
        toolCount: 2
      })
    ])
    expect(JSON.stringify(result)).not.toContain('ENCRYPTED')
  })
})

describe('mcp.add', () => {
  const add = {
    id: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: SECRET }
  }

  it('shows the connector, stores values encrypted, and approves exactly what was shown', async () => {
    const result = await handlers()['mcp.add'](add)
    const shown = deps.mcpTrust.confirm.mock.calls[0][0] as McpServerConfig
    expect(shown).toMatchObject({ id: 'github', command: 'npx', envKeys: ['GITHUB_TOKEN'] })
    expect(JSON.stringify(shown)).not.toContain(SECRET)
    expect(deps.mcpTrust.withEnvironment).toHaveBeenCalledWith(expect.anything(), 'github', {
      GITHUB_TOKEN: SECRET
    })
    expect(deps.mcpTrust.approve).toHaveBeenCalledWith([shown])
    expect(JSON.stringify(stored)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(vi.mocked(deps.settingsChanged).mock.calls)).not.toContain(SECRET)
    expect(result).toMatchObject({ replaced: false, server: { id: 'github', approved: true } })
  })

  it('stores nothing when the user declines', async () => {
    deps.mcpTrust.confirm.mockResolvedValue(false)
    const error = await rejection(handlers()['mcp.add'](add))
    expect(error.code).toBe('denied')
    expect(deps.store.set).not.toHaveBeenCalled()
    expect(deps.mcpTrust.approve).not.toHaveBeenCalled()
  })

  it('requires --replace to change an existing connector, then asks again', async () => {
    const error = await rejection(handlers()['mcp.add']({ id: 'files', command: 'evil' }))
    expect(error.code).toBe('invalid-value')
    expect(deps.mcpTrust.confirm).not.toHaveBeenCalled()

    await handlers()['mcp.add']({ id: 'files', command: 'node', replace: true })
    expect(deps.mcpTrust.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'files', command: 'node' }),
      true
    )
    expect(stored.mcpServers).toEqual([expect.objectContaining({ id: 'files', command: 'node' })])
  })

  it.each([
    [{ id: 'x', url: 'https://mcp.example.com/mcp', env: { TOKEN: SECRET } }, 'usage'],
    [{ id: 'x', command: 'npx', env: { 'BAD-NAME': SECRET } }, 'invalid-value'],
    [{ id: 'x', command: 'npx', env: { TOKEN: '' } }, 'invalid-value'],
    [{ id: 'x', url: 'http://example.com/mcp' }, 'invalid-value'],
    [{ id: 'x', command: 'npx', url: 'https://mcp.example.com/mcp' }, 'usage'],
    [{ id: '../x', command: 'npx' }, 'usage']
  ])('refuses %j without repeating any value', async (params, code) => {
    const error = await rejection(handlers()['mcp.add'](params))
    expect(error.code).toBe(code)
    expect(error.message).not.toContain(SECRET)
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('refuses environment values when secure storage is unavailable', async () => {
    deps.credentialStorage = vi.fn(() => ({ secure: false }))
    const error = await rejection(handlers()['mcp.add'](add))
    expect(error.code).toBe('storage-locked')
    expect(deps.mcpTrust.confirm).not.toHaveBeenCalled()
  })
})

describe('mcp.remove', () => {
  it('removes the connector, its values, and its approval', async () => {
    await handlers()['mcp.remove']({ id: 'files' })
    expect(stored.mcpServers).toEqual([])
    expect(deps.mcpTrust.withEnvironment).toHaveBeenCalledWith(expect.anything(), 'files', {})
    expect(deps.mcpTrust.forget).toHaveBeenCalledWith('files')
  })

  it('reports an unknown connector', async () => {
    expect((await rejection(handlers()['mcp.remove']({ id: 'nope' }))).code).toBe('not-found')
  })
})
