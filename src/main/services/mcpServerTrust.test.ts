import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, isEncryptionAvailable } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  isEncryptionAvailable: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
}))
vi.mock('../ipc/state', () => ({
  getStore: () => ({
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    set: (key: string, value: unknown) => store.set(key, value)
  })
}))

import type { McpServerConfig } from '../../shared/types'
import {
  approveMcpServers,
  changedMcpServers,
  forgetMcpServerApproval,
  isMcpServerApproved,
  mcpServerEnvironment,
  mcpServerFingerprint,
  retainedMcpEnvironment,
  seedMcpApprovals,
  withMcpEnvironment
} from './mcpServerTrust'

const local: McpServerConfig = {
  id: 'files',
  name: 'Files',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-files'],
  envKeys: ['TOKEN'],
  approvalMode: 'prompt',
  enabled: true
}
const remote: McpServerConfig = {
  id: 'docs',
  name: 'Docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  authentication: 'none',
  approvalMode: 'prompt',
  enabled: true
}

function saveSettings(settings: Record<string, unknown>): void {
  store.set('settings', settings)
}

beforeEach(() => {
  store.clear()
  isEncryptionAvailable.mockReturnValue(true)
  saveSettings(withMcpEnvironment({ mcpServers: [local, remote] }, 'files', { TOKEN: 'secret-1' }))
})

describe('MCP server fingerprints', () => {
  it.each([
    ['command', { command: 'node' }],
    ['arguments', { args: ['-y', 'other-server'] }],
    ['working folder', { cwd: '/tmp' }],
    ['environment names', { envKeys: ['TOKEN', 'EXTRA'] }],
    ['read auto-approval', { approvalMode: 'reads-auto' }]
  ])('changes when the %s change', (_label, change) => {
    expect(mcpServerFingerprint({ ...local, ...change } as McpServerConfig)).not.toBe(
      mcpServerFingerprint(local)
    )
  })

  it.each([
    ['URL', { url: 'https://evil.example.com/mcp' }],
    ['authentication', { authentication: 'oauth' }]
  ])('changes when a remote server’s %s changes', (_label, change) => {
    expect(mcpServerFingerprint({ ...remote, ...change } as McpServerConfig)).not.toBe(
      mcpServerFingerprint(remote)
    )
  })

  it('changes when an environment value is replaced, without containing it', () => {
    const before = mcpServerFingerprint(local)
    saveSettings(
      withMcpEnvironment(store.get('settings') as Record<string, unknown>, 'files', {
        TOKEN: 'secret-2'
      })
    )
    const after = mcpServerFingerprint(local)
    expect(after).not.toBe(before)
    expect(after).not.toContain('secret')
  })

  it('ignores the display name and the enabled switch', () => {
    expect(mcpServerFingerprint({ ...local, name: 'Renamed', enabled: false })).toBe(
      mcpServerFingerprint(local)
    )
  })
})

describe('MCP approvals', () => {
  it('approves exact content and asks again after any change', () => {
    approveMcpServers([local])
    expect(isMcpServerApproved(local)).toBe(true)
    expect(isMcpServerApproved({ ...local, name: 'Same thing' })).toBe(true)
    expect(isMcpServerApproved({ ...local, args: ['-y', 'malicious'] })).toBe(false)
    expect(isMcpServerApproved(remote)).toBe(false)
  })

  it('treats a server swapped in under an approved id as unapproved', () => {
    approveMcpServers([local])
    const swapped: McpServerConfig = { ...remote, id: 'files', name: 'Files' }
    expect(isMcpServerApproved(swapped)).toBe(false)
  })

  it('forgets a removed server', () => {
    approveMcpServers([local])
    forgetMcpServerApproval('files')
    expect(isMcpServerApproved(local)).toBe(false)
  })

  it('seeds approvals once for servers configured before this version', () => {
    seedMcpApprovals()
    expect(isMcpServerApproved(local)).toBe(true)
    expect(isMcpServerApproved(remote)).toBe(true)
    const added: McpServerConfig = { ...local, id: 'later' }
    saveSettings({
      ...(store.get('settings') as Record<string, unknown>),
      mcpServers: [local, remote, added]
    })
    seedMcpApprovals()
    expect(isMcpServerApproved(added)).toBe(false)
  })

  it('lists new and edited servers as changed', () => {
    expect(
      changedMcpServers([local, remote], [local, { ...remote, url: 'https://x.example/mcp' }])
    ).toEqual([{ ...remote, url: 'https://x.example/mcp' }])
    expect(changedMcpServers([local], [local, remote])).toEqual([remote])
    expect(changedMcpServers([local], [{ ...local, name: 'Renamed' }])).toEqual([])
  })
})

describe('MCP server environments', () => {
  it('stores values encrypted and decrypts them only for the server that starts', () => {
    const settings = store.get('settings') as Record<string, unknown>
    expect(JSON.stringify(settings)).not.toContain('secret-1')
    expect(mcpServerEnvironment(local)).toEqual({ TOKEN: 'secret-1' })
    expect(mcpServerEnvironment(remote)).toEqual({})
    expect(mcpServerEnvironment({ ...local, envKeys: [] })).toEqual({})
  })

  it('refuses to store values when secure storage is unavailable', () => {
    isEncryptionAvailable.mockReturnValue(false)
    expect(() => withMcpEnvironment({}, 'files', { TOKEN: 'x' })).toThrow()
  })

  it('keeps only stored values for listed names and never takes values from a save', () => {
    const existing = store.get('settings') as Record<string, unknown>
    expect(retainedMcpEnvironment(existing, [local])).toEqual({
      files: { TOKEN: Buffer.from('enc:secret-1').toString('base64') }
    })
    expect(retainedMcpEnvironment(existing, [{ ...local, envKeys: [] }])).toEqual({})
    expect(retainedMcpEnvironment(existing, [remote])).toEqual({})
    expect(retainedMcpEnvironment(undefined, [local])).toEqual({})
  })
})
