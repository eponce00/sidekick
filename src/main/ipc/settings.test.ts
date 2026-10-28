import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  decryptString,
  encryptString,
  isEncryptionAvailable,
  getSelectedStorageBackend,
  storeGet,
  storeSet,
  storeDelete
} = vi.hoisted(() => ({
  decryptString: vi.fn(),
  encryptString: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeDelete: vi.fn()
}))

vi.mock('./state', () => ({
  appState: { mainWindowRef: null },
  getStore: () => ({ get: storeGet, set: storeSet, delete: storeDelete })
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable,
    getSelectedStorageBackend,
    encryptString,
    decryptString
  }
}))

import {
  protectSettings,
  publicSettings,
  revealSettings,
  confirmSensitiveSettingsChange,
  mcpServersNeedingApproval,
  loadStoredSettings,
  registerSettingsHandlers,
  migrateTextScale
} from './settings'
import { ACCENT_PALETTE_VERSION, DEFAULT_ACCENT_PALETTE } from '../../shared/accentPalettes'
import { DEFAULT_TOOL_CALL_LIMIT, TOOL_CALL_LIMIT_POLICY_VERSION } from '../../shared/agentLimits'
import { mcpServerFingerprint } from '../services/mcpServerTrust'
import { dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { isSecureCredentialStorageAvailable } from '../services/secureCredentialStorage'

const encoded = (value: string): string => Buffer.from(`enc:${value}`).toString('base64')

describe('provider secret persistence', () => {
  it('uses an explicit native executable picker and preserves cancellation', async () => {
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:selectOfficeInterpreter')![1]
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await handler({ sender: {} } as IpcMainInvokeEvent)).toEqual({ canceled: true })
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [process.execPath]
    })
    expect(await handler({ sender: {} } as IpcMainInvokeEvent)).toMatchObject({
      canceled: false,
      path: expect.any(String)
    })
    expect(storeSet).not.toHaveBeenCalled()
  })
  it('requires sensitive confirmation before saving a new Office interpreter', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:save')![1]
    expect(
      await handler({ sender: {} } as IpcMainInvokeEvent, {
        officeHelperInterpreter: process.execPath
      })
    ).toMatchObject({ success: false })
    expect(storeSet).not.toHaveBeenCalled()
    expect(vi.mocked(dialog.showMessageBox).mock.calls.at(-1)?.at(-1)).toMatchObject({
      detail: expect.stringContaining('Only choose an interpreter you trust')
    })
  })
  it('requires native confirmation to leave shell isolation and respects cancellation', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    expect(
      await confirmSensitiveSettingsChange(
        { shellIsolation: 'docker' },
        { shellIsolation: 'host' },
        {} as WebContents
      )
    ).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalled()
    vi.mocked(dialog.showMessageBox).mockReset()
  })
  it('rotates the main-owned identity across A to cleared to A and ignores supplied identities', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:save')![1]
    let stored: Record<string, unknown> = {}
    storeGet.mockImplementation(() => stored)
    storeSet.mockImplementation((_key, value) => {
      stored = value
    })
    const ids: unknown[] = []
    for (const interpreter of [process.execPath, undefined, process.execPath]) {
      expect(
        await handler({ sender: {} } as IpcMainInvokeEvent, {
          officeHelperInterpreter: interpreter,
          officeHelperConfigurationId: 'forged'
        })
      ).toMatchObject({ success: true })
      ids.push(stored.officeHelperConfigurationId)
    }
    expect(new Set(ids).size).toBe(3)
    expect(ids).not.toContain('forged')
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
  })
  beforeEach(() => {
    storeGet.mockReset().mockReturnValue({})
    storeSet.mockReset()
    vi.mocked(ipcMain.handle).mockClear()
    isEncryptionAvailable.mockReset().mockReturnValue(true)
    getSelectedStorageBackend.mockReset().mockReturnValue('gnome_libsecret')
    encryptString.mockReset().mockImplementation((value: string) => Buffer.from(`enc:${value}`))
    decryptString.mockReset()
    decryptString.mockImplementation((buffer: Buffer) =>
      buffer.toString('utf8').replace(/^enc:/, '')
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('IPC save failure is non-mutating and returns a friendly secret-free error', async () => {
    isEncryptionAvailable.mockReturnValue(false)
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:save')![1]
    const result = await handler({ sender: {} } as IpcMainInvokeEvent, {
      providerInstances: [{ id: 'private', apiKey: 'SYNTHETIC_PRIVATE_INPUT' }]
    })
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Secure credential storage')
    })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_INPUT')
    expect(storeSet).not.toHaveBeenCalled()
  })

  it('IPC load defers legacy migration without changing or revealing secrets when storage is locked', async () => {
    isEncryptionAvailable.mockReturnValue(false)
    const stored = {
      openRouterApiKey: 'SYNTHETIC_LEGACY_PLAINTEXT',
      __encryptedSecrets: { openRouterApiKey: encoded('saved-key') }
    }
    storeGet.mockReturnValue(stored)
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:load')![1]
    const result = await handler({} as IpcMainInvokeEvent)
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_LEGACY_PLAINTEXT')
    expect(result).not.toHaveProperty('__encryptedSecrets')
    expect(result).toMatchObject({ openRouterApiKeyConfigured: true })
    // Only the settings that hold no credential move to their current policies.
    for (const [, written] of storeSet.mock.calls) {
      expect(written).toMatchObject(stored)
      expect(written).not.toHaveProperty('providerInstances')
    }
  })

  it('refuses plaintext credential saves when encryption is unavailable', () => {
    isEncryptionAvailable.mockReturnValue(false)
    for (const value of [
      { openRouterApiKey: 'SYNTHETIC_SECRET' },
      { providerInstances: [{ id: 'private', apiKey: 'SYNTHETIC_SECRET' }] }
    ]) {
      expect(() => protectSettings(value)).toThrow(/Secure credential storage is unavailable/)
    }
    expect(encryptString).not.toHaveBeenCalled()
  })

  it('does not lose historical plaintext on unrelated saves and migrates it once unlocked', () => {
    const stored = {
      openRouterApiKey: 'old-legacy-secret',
      providerInstances: [{ id: 'private', apiKey: 'old-provider-secret' }]
    }
    const next = { theme: 'dark', providerInstances: [{ id: 'private' }] }
    isEncryptionAvailable.mockReturnValue(false)
    expect(() => protectSettings(next, stored)).toThrow(/Secure credential storage/)
    expect(() =>
      protectSettings(
        { providerInstances: [{ id: 'private' }] },
        { providerInstances: stored.providerInstances }
      )
    ).toThrow(/Secure credential storage/)
    expect(() =>
      protectSettings({ openRouterApiKey: '', providerInstances: [] }, stored)
    ).not.toThrow()
    expect(() =>
      protectSettings(
        { openRouterApiKey: '', providerInstances: [{ id: 'private', apiKey: '' }] },
        stored
      )
    ).not.toThrow()
    isEncryptionAvailable.mockReturnValue(true)
    const migrated = protectSettings(next, stored)
    expect(migrated).toMatchObject({
      __encryptedSecrets: { openRouterApiKey: encoded('old-legacy-secret') },
      __encryptedProviderSecrets: { private: encoded('old-provider-secret') }
    })
    expect(JSON.stringify(migrated)).not.toContain('old-legacy-secret')
    expect(JSON.stringify(migrated)).not.toContain('old-provider-secret')
    expect(stored.providerInstances[0].apiKey).toBe('old-provider-secret')
  })

  it('fails closed for Linux basic_text and unknown backends, even if encryption reports available', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    for (const backend of ['basic_text', 'unknown']) {
      getSelectedStorageBackend.mockReturnValue(backend)
      expect(isSecureCredentialStorageAvailable()).toBe(false)
      expect(() => protectSettings({ providerInstances: [{ id: 'p', apiKey: 'secret' }] })).toThrow(
        /Secure credential storage/
      )
      expect(revealSettings({ lmStudioApiKey: 'plaintext' })).not.toHaveProperty('lmStudioApiKey')
    }
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      getSelectedStorageBackend.mockReturnValue(backend)
      expect(isSecureCredentialStorageAvailable()).toBe(true)
    }
    getSelectedStorageBackend.mockImplementation(() => {
      throw new Error('native error')
    })
    expect(isSecureCredentialStorageAvailable()).toBe(false)
  })

  it('preserves existing ciphertext on unrelated locked-keychain saves and permits no-key providers', () => {
    isEncryptionAvailable.mockReturnValue(false)
    const existing = {
      __encryptedSecrets: { openRouterApiKey: encoded('legacy') },
      __encryptedProviderSecrets: { private: encoded('existing-key') }
    }
    const saved = protectSettings(
      { theme: 'dark', providerInstances: [{ id: 'private' }, { id: 'local', apiKey: '' }] },
      existing
    )
    expect(saved).toMatchObject(existing)
    expect(() =>
      protectSettings({ providerInstances: [{ id: 'local', apiKey: '' }] })
    ).not.toThrow()
    const cleared = protectSettings(
      { providerInstances: [{ id: 'private', apiKey: '' }] },
      existing
    )
    expect(cleared).toMatchObject({ __encryptedProviderSecrets: {} })
    expect(existing.__encryptedProviderSecrets.private).toBe(encoded('existing-key'))
  })

  it('does not accept caller-supplied ciphertext or expose encrypted maps to the renderer', () => {
    expect(protectSettings({ __encryptedProviderSecrets: { private: 'untrusted' } })).toMatchObject(
      { __encryptedProviderSecrets: {} }
    )
    expect(
      publicSettings({
        __encryptedSecrets: { openRouterApiKey: 'encrypted' },
        __encryptedProviderSecrets: { private: 'encrypted' }
      })
    ).toEqual({
      openRouterApiKeyConfigured: false,
      ollamaCloudApiKeyConfigured: false,
      lmStudioApiKeyConfigured: false
    })
  })

  it('locked reads strip historical plaintext but retain encrypted-presence markers', () => {
    isEncryptionAvailable.mockReturnValue(false)
    const stored = {
      openRouterApiKey: 'SYNTHETIC_OLD_PLAINTEXT',
      __encryptedSecrets: { openRouterApiKey: encoded('legacy') },
      providerInstances: [{ id: 'private', apiKey: 'SYNTHETIC_OLD_PLAINTEXT' }],
      __encryptedProviderSecrets: { private: encoded('provider') }
    }
    const revealed = revealSettings(stored)
    expect(JSON.stringify(revealed)).not.toContain('SYNTHETIC_OLD_PLAINTEXT')
    expect(publicSettings(revealed)).toMatchObject({
      openRouterApiKeyConfigured: true,
      providerInstances: [{ id: 'private', apiKeyConfigured: true }]
    })
    expect(decryptString).not.toHaveBeenCalled()
    expect(stored.providerInstances[0].apiKey).toBe('SYNTHETIC_OLD_PLAINTEXT')
  })

  it('does not leak native encryption/decryption errors or clear undecryptable legacy ciphertext', () => {
    encryptString.mockImplementation(() => {
      throw new Error('SYNTHETIC_SECRET')
    })
    expect(() => protectSettings({ lmStudioApiKey: 'secret' })).toThrow(/Secure credential storage/)
    try {
      protectSettings({ lmStudioApiKey: 'secret' })
    } catch (error) {
      expect(String(error)).not.toContain('SYNTHETIC_SECRET')
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      decryptString.mockImplementation(() => {
        throw new Error('SYNTHETIC_SECRET')
      })
      const stored = { __encryptedSecrets: { lmStudioApiKey: encoded('legacy') } }
      const revealed = revealSettings(stored)
      expect(revealed).not.toHaveProperty('lmStudioApiKey')
      expect(protectSettings(revealed, stored)).toMatchObject(stored)
      expect(JSON.stringify(warning.mock.calls)).not.toContain('SYNTHETIC_SECRET')
    } finally {
      warning.mockRestore()
    }
  })

  it('preserves an encrypted key when an unrelated save omits apiKey', () => {
    const protectedSettings = protectSettings(
      {
        providerInstances: [{ id: 'private', name: 'Private', models: [] }]
      },
      {
        __encryptedProviderSecrets: { private: encoded('existing-key') }
      }
    ) as Record<string, unknown>

    expect(protectedSettings.__encryptedProviderSecrets).toEqual({
      private: encoded('existing-key')
    })
  })

  it('keeps a saved key only while the provider keeps the base URL it was saved with', () => {
    const existing = {
      providerInstances: [{ id: 'private', baseUrl: 'https://provider.test/v1' }],
      __encryptedProviderSecrets: { private: encoded('existing-key') }
    }
    const save = (instance: Record<string, unknown>) =>
      (
        protectSettings(
          { providerInstances: [{ id: 'private', ...instance }] },
          existing
        ) as Record<string, unknown>
      ).__encryptedProviderSecrets

    expect(save({ baseUrl: 'https://provider.test/v1/' })).toEqual({
      private: encoded('existing-key')
    })
    expect(save({ baseUrl: 'https://elsewhere.test/v1' })).toEqual({})
    expect(save({ baseUrl: 'https://elsewhere.test/v1', apiKey: 'new-key' })).toEqual({
      private: encoded('new-key')
    })
  })

  it('replaces, explicitly clears, and removes provider secrets', () => {
    const existing = {
      __encryptedProviderSecrets: {
        private: encoded('existing-key'),
        removed: encoded('removed-key')
      }
    }
    const replaced = protectSettings(
      { providerInstances: [{ id: 'private', apiKey: 'new-key' }] },
      existing
    ) as Record<string, unknown>
    expect(replaced.__encryptedProviderSecrets).toEqual({ private: encoded('new-key') })

    const cleared = protectSettings(
      { providerInstances: [{ id: 'private', apiKey: '' }] },
      existing
    ) as Record<string, unknown>
    expect(cleared.__encryptedProviderSecrets).toEqual({})
  })

  it('does not turn a decryption failure into an explicit clear', () => {
    decryptString.mockImplementationOnce(() => {
      throw new Error('unavailable')
    })
    const revealed = revealSettings({
      providerInstances: [{ id: 'private' }],
      __encryptedProviderSecrets: { private: encoded('existing-key') }
    }) as { providerInstances: Array<Record<string, unknown>> }

    expect(revealed.providerInstances[0]).not.toHaveProperty('apiKey')
  })

  it('does not decrypt or retain a duplicated legacy secret', () => {
    const rawSettings = {
      providerInstances: [{ id: 'private', type: 'openai-compatible' }],
      __encryptedSecrets: { lmStudioApiKey: encoded('same-key') },
      __encryptedProviderSecrets: { private: encoded('same-key') }
    }
    const revealed = revealSettings(rawSettings) as Record<string, unknown>
    expect(revealed).not.toHaveProperty('lmStudioApiKey')
    expect(decryptString).toHaveBeenCalledTimes(1)

    const protectedSettings = protectSettings(
      {
        ...revealed,
        lmStudioApiKey: '',
        providerInstances: [{ id: 'private', type: 'openai-compatible', apiKey: 'same-key' }]
      },
      rawSettings
    ) as Record<string, unknown>
    expect(protectedSettings.__encryptedSecrets).toEqual({})
  })

  it('returns only credential-presence markers to the renderer', () => {
    const value = publicSettings({
      openRouterApiKey: 'legacy-secret',
      providerInstances: [{ id: 'private', name: 'Private', apiKey: 'provider-secret', models: [] }]
    }) as Record<string, unknown> & {
      openRouterApiKeyConfigured: boolean
      providerInstances: Array<Record<string, unknown> & { apiKeyConfigured: boolean }>
    }

    expect(value).not.toHaveProperty('openRouterApiKey')
    expect(value.openRouterApiKeyConfigured).toBe(true)
    expect(value.providerInstances[0]).not.toHaveProperty('apiKey')
    expect(value.providerInstances[0].apiKeyConfigured).toBe(true)
  })
})

describe('MCP server environment values', () => {
  const server = {
    id: 'files',
    name: 'Files',
    transport: 'stdio',
    command: 'npx',
    envKeys: ['TOKEN'],
    approvalMode: 'prompt',
    enabled: true
  }
  const stored = {
    mcpServers: [server],
    __encryptedMcpEnv: { files: { TOKEN: encoded('real') } }
  }

  it('keeps stored values on save and ignores any a renderer supplies', () => {
    isEncryptionAvailable.mockReturnValue(true)
    getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    const saved = protectSettings(
      {
        mcpServers: [server, { ...server, id: 'planted', envKeys: ['TOKEN'] }],
        __encryptedMcpEnv: { files: { TOKEN: encoded('forged') }, planted: { TOKEN: 'x' } }
      },
      stored
    ) as Record<string, unknown>
    expect(saved.__encryptedMcpEnv).toEqual({ files: { TOKEN: encoded('real') } })
  })

  it('drops values for removed servers and names', () => {
    const saved = protectSettings({ mcpServers: [{ ...server, envKeys: [] }] }, stored) as Record<
      string,
      unknown
    >
    expect(saved.__encryptedMcpEnv).toEqual({})
  })

  it('never sends encrypted values to the renderer', () => {
    isEncryptionAvailable.mockReturnValue(true)
    getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    expect(JSON.stringify(publicSettings(revealSettings(stored)))).not.toContain(
      '__encryptedMcpEnv'
    )
    expect(JSON.stringify(publicSettings(stored))).not.toContain(encoded('real'))
  })
})

describe('MCP servers that a save must ask about', () => {
  const server = {
    id: 'files',
    name: 'Files',
    transport: 'stdio' as const,
    command: 'npx',
    approvalMode: 'prompt' as const,
    enabled: true
  }
  function approve(...servers: Array<typeof server>): void {
    const fingerprints = Object.fromEntries(
      servers.map((item) => [item.id, mcpServerFingerprint(item, {})])
    )
    storeGet.mockImplementation((key: string, fallback?: unknown) =>
      key === 'mcpApprovals' ? { version: 1, fingerprints } : key === 'settings' ? {} : fallback
    )
  }

  it('leaves an untouched unapproved server out of an unrelated save', () => {
    approve()
    expect(
      mcpServersNeedingApproval(
        { mcpServers: [server], webSearchEnabled: true },
        { mcpServers: [server], webSearchEnabled: false }
      )
    ).toEqual([])
  })

  it('asks about an edited server even when its old form was approved', () => {
    approve(server)
    const edited = { ...server, args: ['--evil'] }
    expect(mcpServersNeedingApproval({ mcpServers: [server] }, { mcpServers: [edited] })).toEqual([
      edited
    ])
  })

  it('asks when an unapproved server is switched on, but not an approved one', () => {
    approve(server)
    const other = { ...server, id: 'other', command: 'node' }
    expect(
      mcpServersNeedingApproval(
        {
          mcpServers: [
            { ...server, enabled: false },
            { ...other, enabled: false }
          ]
        },
        { mcpServers: [server, other] }
      )
    ).toEqual([other])
  })
})

describe('retired settings', () => {
  afterEach(() => {
    storeGet.mockReset()
    storeSet.mockReset()
  })

  it('removes settings SideKick no longer has when it loads', async () => {
    let stored: Record<string, unknown> = {
      agentCommandTerminal: false,
      focusChainReminderInterval: 15,
      webSearchEnabled: false,
      providerInstances: []
    }
    storeGet.mockImplementation((key: string, fallback: unknown) =>
      key === 'settings' ? stored : fallback
    )
    storeSet.mockImplementation((key: string, value: Record<string, unknown>) => {
      if (key === 'settings') stored = value
    })
    registerSettingsHandlers()
    const load = vi
      .mocked(ipcMain.handle)
      .mock.calls.findLast(([channel]) => channel === 'settings:load')![1]
    const loaded = (await load({ sender: {} } as IpcMainInvokeEvent)) as Record<string, unknown>
    expect(stored).not.toHaveProperty('agentCommandTerminal')
    expect(stored).not.toHaveProperty('focusChainReminderInterval')
    expect(stored).toMatchObject({ webSearchEnabled: false })
    expect(loaded).not.toHaveProperty('agentCommandTerminal')
  })
})

describe('text size', () => {
  afterEach(() => {
    storeGet.mockReset()
    storeSet.mockReset()
    storeDelete.mockReset()
  })

  function storeWith(values: Record<string, unknown>): Record<string, unknown> {
    storeGet.mockImplementation((key: string, fallback: unknown) =>
      key in values ? values[key] : fallback
    )
    storeSet.mockImplementation((key: string, value: unknown) => {
      values[key] = value
    })
    return values
  }

  it('folds the old window zoom and conversation text size into one size', () => {
    const values = storeWith({
      desktopZoomFactorV1: 1,
      settings: { contentFontSize: 13, webSearchEnabled: false }
    })
    migrateTextScale()
    expect(values.settings).toMatchObject({ textScale: 110, webSearchEnabled: false })
    expect(values.settings).not.toHaveProperty('contentFontSize')
    expect(storeDelete).toHaveBeenCalledWith('desktopZoomFactorV1')
  })

  it('leaves stored settings alone when there is nothing to move', () => {
    storeWith({ settings: { textScale: 120 } })
    migrateTextScale()
    expect(storeSet).not.toHaveBeenCalled()
  })
})

describe('settings writers', () => {
  let stored: Record<string, unknown>
  const handler = (channel: string) =>
    vi.mocked(ipcMain.handle).mock.calls.findLast(([name]) => name === channel)![1]
  const save = (changes: Record<string, unknown>) =>
    handler('settings:save')({ sender: {} } as IpcMainInvokeEvent, changes) as Promise<{
      success: boolean
    }>
  const provider = (id: string, apiKey?: string) => ({
    id,
    name: `Provider ${id}`,
    type: 'openai-compatible',
    preset: 'generic',
    enabled: true,
    baseUrl: `http://127.0.0.1:4000/${id}/v1`,
    modelSource: 'manual',
    models: [{ id: 'model', enabled: true }],
    ...(apiKey ? { apiKey } : {})
  })

  beforeEach(() => {
    stored = {}
    storeGet
      .mockReset()
      .mockImplementation((key: string, fallback?: unknown) =>
        key === 'settings' ? stored : fallback
      )
    storeSet.mockReset().mockImplementation((key: string, value: Record<string, unknown>) => {
      if (key === 'settings') stored = value
    })
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(dialog.showMessageBox).mockReset()
    isEncryptionAvailable.mockReset().mockReturnValue(true)
    getSelectedStorageBackend.mockReset().mockReturnValue('gnome_libsecret')
    encryptString.mockReset().mockImplementation((value: string) => Buffer.from(`enc:${value}`))
    decryptString
      .mockReset()
      .mockImplementation((buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''))
    registerSettingsHandlers()
  })

  it('keeps a provider another writer added while a save waited for its approval', async () => {
    stored = { shellIsolation: 'docker', providerInstances: [] }
    let approve!: (result: { response: number; checkboxChecked: boolean }) => void
    vi.mocked(dialog.showMessageBox).mockReturnValue(
      new Promise((done) => (approve = done)) as never
    )
    // The first save leaves container isolation, so it waits on the approval dialog. It read the
    // stored settings before the second save added a provider and its key.
    const leavingIsolation = save({ shellIsolation: 'host' })
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalled())
    expect(await save({ providerInstances: [provider('added', 'added-key')] })).toEqual({
      success: true
    })
    approve({ response: 1, checkboxChecked: false })
    expect(await leavingIsolation).toEqual({ success: true })

    expect(stored).toMatchObject({
      shellIsolation: 'host',
      providerInstances: [expect.objectContaining({ id: 'added' })],
      __encryptedProviderSecrets: { added: encoded('added-key') }
    })
    expect(JSON.stringify(stored)).not.toContain('"added-key"')
  })

  it('replaces only the settings a save names', async () => {
    expect(
      await save({
        providerInstances: [provider('family-provider', 'family-key')],
        selectedModel: 'lmstudio:family-provider/model',
        notificationsEnabled: false
      })
    ).toEqual({ success: true })
    expect(await save({ selectedModel: 'lmstudio:family-provider/other' })).toEqual({
      success: true
    })
    expect(await save({ reasoningLevels: { 'lmstudio:family-provider/other': 'high' } })).toEqual({
      success: true
    })

    expect(stored).toMatchObject({
      providerInstances: [expect.objectContaining({ id: 'family-provider' })],
      selectedModel: 'lmstudio:family-provider/other',
      notificationsEnabled: false,
      reasoningLevels: { 'lmstudio:family-provider/other': 'high' },
      __encryptedProviderSecrets: { 'family-provider': encoded('family-key') }
    })
  })

  it('stores what a load migrates itself, so a later save has nothing to write back', async () => {
    const loaded = (await handler('settings:load')({} as IpcMainInvokeEvent)) as Record<
      string,
      unknown
    >
    expect(loaded).toMatchObject({
      toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION,
      accentPaletteVersion: ACCENT_PALETTE_VERSION,
      providerInstances: []
    })
    expect(stored).toMatchObject({
      toolCallLimit: DEFAULT_TOOL_CALL_LIMIT,
      toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION,
      accentPalette: DEFAULT_ACCENT_PALETTE,
      accentPaletteVersion: ACCENT_PALETTE_VERSION,
      providerInstances: []
    })

    // A provider saved right after the window loaded stays through the next load.
    await save({ providerInstances: [provider('family-provider')] })
    storeSet.mockClear()
    await handler('settings:load')({} as IpcMainInvokeEvent)
    expect(storeSet).not.toHaveBeenCalled()
    expect(stored.providerInstances).toEqual([provider('family-provider')])
  })

  it('moves an old tool-call limit to the current policy and keeps a chosen one', async () => {
    stored = { toolCallLimit: 80, toolCallLimitVersion: 4, providerInstances: [] }
    await handler('settings:load')({} as IpcMainInvokeEvent)
    expect(stored).toMatchObject({
      toolCallLimit: DEFAULT_TOOL_CALL_LIMIT,
      toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION
    })

    await save({ toolCallLimit: 80 })
    await handler('settings:load')({} as IpcMainInvokeEvent)
    expect(stored).toMatchObject({ toolCallLimit: 80 })
  })

  it('reads pre-instance settings as providers while the keychain is locked, writing none', async () => {
    isEncryptionAvailable.mockReturnValue(false)
    stored = { lmStudioEndpoint: 'http://127.0.0.1:1234/v1', toolCallLimitVersion: 5 }
    storeGet.mockImplementation((key: string, fallback?: unknown) =>
      key === 'settings'
        ? stored
        : key === 'pinnedModels'
          ? [{ id: 'old', name: 'old-model', provider: 'lmstudio' }]
          : fallback
    )
    expect(loadStoredSettings().providerInstances).toEqual([
      expect.objectContaining({
        id: 'lm-studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: [expect.objectContaining({ id: 'old-model' })]
      })
    ])
    expect(stored).not.toHaveProperty('providerInstances')
    expect(storeSet).not.toHaveBeenCalled()
  })
})
