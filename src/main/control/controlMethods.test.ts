import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const { encryptString, isEncryptionAvailable } = vi.hoisted(() => ({
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  isEncryptionAvailable: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString,
    decryptString: vi.fn()
  }
}))
vi.mock('../ipc/state', () => ({ appState: { mainWindowRef: null }, getStore: vi.fn() }))

import { ControlError } from '../../shared/controlProtocol'
import { createControlHandlers, type ControlMethodDependencies } from './controlMethods'

const PROVIDER_SECRET = 'sk-or-v1-PROVIDERSECRET'
const LEGACY_SECRET = 'sk-LEGACYPLAINTEXT'
const ENCRYPTED_BLOB = Buffer.from('enc:STORED').toString('base64')

function storedFixture(): Record<string, unknown> {
  return {
    commandPermissionMode: 'always-ask',
    shellIsolation: 'docker',
    webSearchEnabled: false,
    openRouterApiKey: LEGACY_SECRET,
    officeHelperInterpreter: '/usr/bin/python3',
    strayKey: 1,
    contentFontSize: 99,
    providerInstances: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelSource: 'manual',
        models: [{ id: 'model-a', enabled: true }]
      },
      {
        id: 'local',
        name: 'Ollama',
        type: 'ollama',
        enabled: true,
        baseUrl: 'http://localhost:11434',
        modelSource: 'discover',
        models: []
      }
    ],
    mcpServers: [
      { id: 'files', name: 'Files', transport: 'stdio', command: 'npx', enabled: true },
      { id: 'off', name: 'Off', transport: 'stdio', command: 'x', enabled: false }
    ],
    __encryptedSecrets: { ollamaCloudApiKey: ENCRYPTED_BLOB },
    __encryptedProviderSecrets: { openrouter: ENCRYPTED_BLOB }
  }
}

let stored: Record<string, unknown>
let deps: ControlMethodDependencies & {
  confirmSensitiveChange: Mock<ControlMethodDependencies['confirmSensitiveChange']>
  settingsChanged: Mock<ControlMethodDependencies['settingsChanged']>
}

function handlers(): ReturnType<typeof createControlHandlers> {
  return createControlHandlers(deps)
}

function expectNoSecretMaterial(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [PROVIDER_SECRET, LEGACY_SECRET, ENCRYPTED_BLOB, 'enc:', '__encrypted']) {
    expect(text).not.toContain(secret)
  }
}

beforeEach(() => {
  stored = storedFixture()
  isEncryptionAvailable.mockReturnValue(true)
  deps = {
    store: {
      get: vi.fn((key: string, fallback?: unknown) => (key === 'settings' ? stored : fallback)),
      set: vi.fn((key: string, value: unknown) => {
        if (key === 'settings') stored = value as Record<string, unknown>
      })
    },
    appVersion: '1.2.3',
    platform: 'linux-x64',
    settingsFile: 'config.json',
    credentialStorage: vi.fn(() => ({ secure: true, backend: 'gnome_libsecret' })),
    confirmSensitiveChange: vi.fn(async () => true),
    settingsChanged: vi.fn(),
    mcpStatuses: vi.fn(async () => [
      { serverId: 'files', serverName: 'Files', status: 'connected' as const, toolCount: 3 }
    ]),
    confirmProviderEndpoint: vi.fn(async () => true),
    mcpTrust: {
      isApproved: vi.fn(() => true),
      approve: vi.fn(),
      forget: vi.fn(),
      withEnvironment: vi.fn((settings) => settings),
      confirm: vi.fn(async () => true)
    }
  }
})

async function rejection(promise: Promise<unknown>): Promise<ControlError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ControlError)
  return error as ControlError
}

describe('control methods never reveal secrets', () => {
  it('lists only schema settings and no credential material', async () => {
    const result = await handlers()['config.list']({})
    expectNoSecretMaterial(result)
    const keys = result.settings.map((setting) => setting.key)
    expect(keys).toContain('webSearchEnabled')
    expect(keys).not.toContain('openRouterApiKey')
    expect(keys).not.toContain('providerInstances')
    expect(keys).not.toContain('officeHelperInterpreter')
    expect(result.settings.find((setting) => setting.key === 'webSearchEnabled')).toMatchObject({
      value: false,
      isDefault: false
    })
  })

  it.each([
    'openRouterApiKey',
    'ollamaCloudApiKey',
    '__encryptedProviderSecrets',
    '__encryptedSecrets',
    'providerInstances',
    'mcpServers',
    'officeHelperInterpreter',
    'projectStartHooks',
    '__proto__',
    'constructor'
  ])('refuses to read or write %s', async (key) => {
    const before = JSON.stringify(stored)
    for (const call of [
      handlers()['config.get']({ key }),
      handlers()['config.set']({ key, value: 'x' }),
      handlers()['config.unset']({ key })
    ]) {
      const error = await rejection(call)
      expect(error.code).toBe('not-found')
      expectNoSecretMaterial(error.message)
    }
    expect(JSON.stringify(stored)).toBe(before)
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('does not echo an unknown key that could be a pasted secret', async () => {
    const error = await rejection(handlers()['config.get']({ key: 'sk-ant-api03-XYZ' }))
    expect(error.message).not.toContain('sk-ant')
  })

  it('reports provider keys and storage as booleans only in doctor', async () => {
    const report = await handlers().doctor({})
    expectNoSecretMaterial(report)
    expect(report.providers).toEqual([
      {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        enabled: true,
        apiKeyConfigured: true
      },
      { id: 'local', name: 'Ollama', type: 'ollama', enabled: true, apiKeyConfigured: false }
    ])
    expect(report.unknownKeys).toEqual(['strayKey'])
    expect(report.invalidSettings).toEqual([
      { key: 'contentFontSize', reason: 'expected 12 to 17' }
    ])
    expect(report.credentialStorage).toEqual({ secure: true, backend: 'gnome_libsecret' })
    expect(report.mcpServers).toEqual([
      {
        id: 'files',
        name: 'Files',
        transport: 'stdio',
        enabled: true,
        approved: true,
        status: 'connected',
        toolCount: 3
      },
      {
        id: 'off',
        name: 'Off',
        transport: 'stdio',
        enabled: false,
        approved: true,
        status: 'disabled',
        toolCount: 0
      }
    ])
  })

  it('reports connector health as unknown when it does not arrive in time', async () => {
    deps.mcpStatuses = vi.fn(() => new Promise<never>(() => undefined))
    deps.mcpStatusTimeoutMs = 10
    const report = await handlers().doctor({})
    expect(report.mcpServers[0]).toMatchObject({ id: 'files', status: 'unknown' })
  })
})

describe('config.set', () => {
  it('validates, writes only the one key, and keeps encrypted credentials intact', async () => {
    const result = await handlers()['config.set']({ key: 'webSearchEnabled', value: 'true' })
    expect(result).toEqual({ key: 'webSearchEnabled', previous: false, value: true, changed: true })
    expect(stored.webSearchEnabled).toBe(true)
    expect(stored.__encryptedProviderSecrets).toEqual({ openrouter: ENCRYPTED_BLOB })
    expect(stored.__encryptedSecrets).toEqual({ ollamaCloudApiKey: ENCRYPTED_BLOB })
    expect(deps.settingsChanged).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['webSearchEnabled', 'yes'],
    ['contentFontSize', '30'],
    ['contentFontSize', '13.5'],
    ['commandPermissionMode', 'bypass'],
    ['manualLocation', 'line\nbreak'],
    ['selectedModel', 'openai:nowhere/model']
  ])('refuses %s = %j', async (key, value) => {
    const error = await rejection(handlers()['config.set']({ key, value }))
    expect(error.code).toBe('invalid-value')
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('accepts a configured model id', async () => {
    const result = await handlers()['config.set']({
      key: 'selectedModel',
      value: 'openrouter:openrouter/model-a'
    })
    expect(result.value).toBe('openrouter:openrouter/model-a')
  })

  it('writes companion values with the tool call limit', async () => {
    await handlers()['config.set']({ key: 'toolCallLimit', value: 120 })
    expect(stored).toMatchObject({ toolCallLimit: 120, toolCallLimitVersion: expect.any(Number) })
  })

  it('asks before weakening security and leaves settings alone when declined', async () => {
    deps.confirmSensitiveChange.mockResolvedValue(false)
    const error = await rejection(
      handlers()['config.set']({ key: 'commandPermissionMode', value: 'full-access' })
    )
    expect(error.code).toBe('denied')
    expect(deps.confirmSensitiveChange).toHaveBeenCalledWith(
      expect.objectContaining({ commandPermissionMode: 'always-ask' }),
      expect.objectContaining({ commandPermissionMode: 'full-access' })
    )
    expect(stored.commandPermissionMode).toBe('always-ask')
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('asks before unsetting into a weaker default', async () => {
    deps.confirmSensitiveChange.mockResolvedValue(false)
    await rejection(handlers()['config.unset']({ key: 'shellIsolation' }))
    expect(deps.confirmSensitiveChange.mock.calls[0][1]).not.toHaveProperty('shellIsolation')
    expect(stored.shellIsolation).toBe('docker')
  })

  it('applies an approved change to settings saved while the dialog was open', async () => {
    deps.confirmSensitiveChange.mockImplementation(async () => {
      stored = { ...stored, notificationsEnabled: false }
      return true
    })
    await handlers()['config.set']({ key: 'shellIsolation', value: 'host' })
    expect(stored).toMatchObject({ shellIsolation: 'host', notificationsEnabled: false })
    expect(stored.officeHelperConfigurationId).toEqual(expect.any(String))
  })

  it('reports what the app uses for a migrated stored value', async () => {
    stored.commandPermissionMode = 'agent-decides'
    const result = await handlers()['config.get']({ key: 'commandPermissionMode' })
    expect(result.value).toBe('sensitive-only')
  })
})

describe('auth.set', () => {
  it('stores the key encrypted and never returns it', async () => {
    const result = await handlers()['auth.set']({
      providerInstanceId: 'local',
      secret: PROVIDER_SECRET
    })
    expect(result).toEqual({ providerInstanceId: 'local', apiKeyConfigured: true })
    expectNoSecretMaterial(result)
    const providerSecrets = stored.__encryptedProviderSecrets as Record<string, string>
    expect(Buffer.from(providerSecrets.local, 'base64').toString()).toBe(`enc:${PROVIDER_SECRET}`)
    expect(providerSecrets.openrouter).toBe(ENCRYPTED_BLOB)
    expect(JSON.stringify(stored)).not.toContain(PROVIDER_SECRET)
    expect(deps.settingsChanged.mock.calls[0][0]).not.toHaveProperty([
      'providerInstances',
      1,
      'apiKey'
    ])
    expect(JSON.stringify(deps.settingsChanged.mock.calls)).not.toContain(PROVIDER_SECRET)
  })

  it('does not echo an unknown provider id, which may be a misplaced key', async () => {
    const error = await rejection(
      handlers()['auth.set']({ providerInstanceId: 'sk-ant-api03-MISPLACED', secret: 'abc' })
    )
    expect(error.code).toBe('not-found')
    expect(error.message).not.toContain('MISPLACED')
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', ''],
    ['whitespace', 'sk-abc def'],
    ['newline', 'sk-abc\n'],
    ['too long', 'k'.repeat(9_000)],
    ['not text', 42]
  ])('refuses a %s key without repeating it', async (_label, secret) => {
    const error = await rejection(
      handlers()['auth.set']({ providerInstanceId: 'local', secret: secret as string })
    )
    expect(error.code).toBe('invalid-value')
    if (typeof secret === 'string' && secret) expect(error.message).not.toContain(secret.trim())
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('refuses to store a key when secure storage is unavailable', async () => {
    deps.credentialStorage = vi.fn(() => ({ secure: false, backend: 'basic_text' }))
    const error = await rejection(
      handlers()['auth.set']({ providerInstanceId: 'local', secret: PROVIDER_SECRET })
    )
    expect(error.code).toBe('storage-locked')
    expect(deps.store.set).not.toHaveBeenCalled()
  })

  it('reports a native encryption failure without its details', async () => {
    encryptString.mockImplementationOnce(() => {
      throw new Error(`native failure with ${PROVIDER_SECRET}`)
    })
    const error = await rejection(
      handlers()['auth.set']({ providerInstanceId: 'local', secret: PROVIDER_SECRET })
    )
    expect(error.code).toBe('storage-locked')
    expect(error.message).not.toContain(PROVIDER_SECRET)
  })
})
