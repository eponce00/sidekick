import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: vi.fn()
  }
}))
vi.mock('../ipc/state', () => ({ appState: { mainWindowRef: null }, getStore: vi.fn() }))

import { agentRunProfile, getAgentToolEntry } from '../../shared/agentToolCatalog'
import { createControlHandlers } from '../control/controlMethods'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerSettingsToolHandlers } from './agentSettingsToolHandlers'

const BLOB = Buffer.from('enc:sk-or-v1-SECRET').toString('base64')
const ENV_BLOB = Buffer.from('enc:ghp_SECRET').toString('base64')

let stored: Record<string, unknown>
let confirmSensitiveChange: Mock<(previous: unknown, next: unknown) => Promise<boolean>>
let openProviderKeyPrompt: Mock<(providerInstanceId: string) => boolean>
let handlers: AgentToolHandlerRegistry

const context = { runId: 'run', signal: new AbortController().signal } as AgentToolExecutionContext

function call(name: string, args: Record<string, unknown>) {
  return handlers.execute({ name, title: name, arguments: args, context })
}

beforeEach(() => {
  stored = {
    webSearchEnabled: false,
    openRouterApiKey: 'sk-LEGACY-SECRET',
    providerInstances: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelSource: 'discover',
        models: []
      }
    ],
    mcpServers: [
      {
        id: 'github',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        envKeys: ['GITHUB_TOKEN'],
        approvalMode: 'prompt',
        enabled: true
      }
    ],
    __encryptedProviderSecrets: { openrouter: BLOB },
    __encryptedMcpEnv: { github: { GITHUB_TOKEN: ENV_BLOB } }
  }
  confirmSensitiveChange = vi.fn(async () => true)
  openProviderKeyPrompt = vi.fn(() => true)
  const control = createControlHandlers({
    store: {
      get: (key: string, fallback?: unknown) => (key === 'settings' ? stored : fallback),
      set: (_key: string, value: unknown) => {
        stored = value as Record<string, unknown>
      }
    },
    appVersion: '1.0.0',
    platform: 'test',
    settingsFile: 'config.json',
    credentialStorage: () => ({ secure: true, backend: 'test' }),
    confirmSensitiveChange,
    settingsChanged: vi.fn(),
    mcpStatuses: async () => [],
    confirmProviderEndpoint: vi.fn(async () => true),
    mcpTrust: {
      isApproved: () => true,
      approve: vi.fn(),
      forget: vi.fn(),
      withEnvironment: (settings) => settings,
      confirm: vi.fn(async () => true)
    }
  })
  handlers = new AgentToolHandlerRegistry()
  registerSettingsToolHandlers(handlers, { control, openProviderKeyPrompt })
})

describe('settings tools in the catalog', () => {
  it('are offered to conversations but not while planning', () => {
    const acting = agentRunProfile({ surface: 'conversation' })
    const planning = agentRunProfile({ surface: 'conversation', planStage: 'planning' })
    expect(acting.capabilities).toContain('settings')
    expect(planning.capabilities).not.toContain('settings')
  })

  it('always ask before a change, and treat reads as reads', () => {
    const options = { surface: 'conversation' as const }
    expect(getAgentToolEntry(options, 'settings_propose_change')).toMatchObject({
      risk: 'write',
      approval: 'always'
    })
    for (const name of ['settings_read', 'settings_reference', 'provider_request_key']) {
      expect(getAgentToolEntry(options, name)?.risk).toBe('read')
    }
  })
})

describe('settings_read', () => {
  it('reports configuration without any secret', async () => {
    const result = await call('settings_read', {})
    expect(result.status).toBe('success')
    const text = JSON.stringify(result)
    for (const secret of ['SECRET', BLOB, ENV_BLOB, 'enc:', '__encrypted']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('"apiKeyConfigured":true')
    expect(text).toContain('GITHUB_TOKEN')
  })
})

describe('settings_propose_change', () => {
  it('previews the current and proposed value', async () => {
    const preview = await handlers.preview('settings_propose_change', {
      key: 'webSearchEnabled',
      value: 'true',
      reason: 'You asked for web results.'
    })
    expect(preview).toMatchObject({
      changes: [{ label: 'webSearchEnabled', before: 'false', after: 'true' }]
    })
    expect(preview?.summary).toContain('You asked for web results.')
  })

  it('applies an approved change through the shared validation', async () => {
    const result = await call('settings_propose_change', { key: 'webSearchEnabled', value: 'true' })
    expect(result.status).toBe('success')
    expect(stored.webSearchEnabled).toBe(true)
    expect(stored.__encryptedProviderSecrets).toEqual({ openrouter: BLOB })
  })

  it.each([
    'openRouterApiKey',
    'providerInstances',
    'mcpServers',
    '__encryptedProviderSecrets',
    'officeHelperInterpreter',
    'projectStartHooks'
  ])('can never write %s', async (key) => {
    const before = JSON.stringify(stored)
    const result = await call('settings_propose_change', { key, value: 'x' })
    expect(result.status).toBe('error')
    expect(JSON.stringify(stored)).toBe(before)
    expect(await handlers.preview('settings_propose_change', { key, value: 'x' })).toBeUndefined()
  })

  it('still shows SideKick’s own dialog before granting full access, and honours a refusal', async () => {
    stored.commandPermissionMode = 'always-ask'
    confirmSensitiveChange.mockResolvedValue(false)
    const result = await call('settings_propose_change', {
      key: 'commandPermissionMode',
      value: 'full-access'
    })
    expect(confirmSensitiveChange).toHaveBeenCalled()
    expect(result.status).toBe('denied')
    expect(stored.commandPermissionMode).toBe('always-ask')
  })

  it('resets to the default', async () => {
    await call('settings_propose_change', { key: 'webSearchEnabled', reset: true })
    expect(stored).not.toHaveProperty('webSearchEnabled')
  })
})

describe('provider_request_key', () => {
  it('opens the key prompt for a known instance and never asks for the key in chat', async () => {
    const result = await call('provider_request_key', { provider_instance_id: 'openrouter' })
    expect(result.status).toBe('success')
    expect(openProviderKeyPrompt).toHaveBeenCalledWith('openrouter')
  })

  it('refuses an unknown instance without opening anything', async () => {
    const result = await call('provider_request_key', { provider_instance_id: 'nope' })
    expect(result.status).toBe('error')
    expect(openProviderKeyPrompt).not.toHaveBeenCalled()
  })
})
