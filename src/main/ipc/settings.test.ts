import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  decryptString,
  encryptString,
  isEncryptionAvailable,
  getSelectedStorageBackend,
  storeGet,
  storeSet
} = vi.hoisted(() => ({
  decryptString: vi.fn(),
  encryptString: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn()
}))

vi.mock('./state', () => ({ getStore: () => ({ get: storeGet, set: storeSet }) }))

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
  registerSettingsHandlers
} from './settings'
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

  it('IPC load defers legacy migration without writing or revealing secrets when storage is locked', async () => {
    isEncryptionAvailable.mockReturnValue(false)
    storeGet.mockReturnValue({
      openRouterApiKey: 'SYNTHETIC_LEGACY_PLAINTEXT',
      __encryptedSecrets: { openRouterApiKey: encoded('saved-key') }
    })
    registerSettingsHandlers()
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'settings:load')![1]
    const result = await handler({} as IpcMainInvokeEvent)
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_LEGACY_PLAINTEXT')
    expect(result).not.toHaveProperty('__encryptedSecrets')
    expect(result).toMatchObject({ openRouterApiKeyConfigured: true })
    expect(storeSet).not.toHaveBeenCalled()
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
