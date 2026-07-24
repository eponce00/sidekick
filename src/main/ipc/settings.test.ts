import { beforeEach, describe, expect, it, vi } from 'vitest'

const { decryptString } = vi.hoisted(() => ({
  decryptString: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString
  }
}))

import { protectSettings, publicSettings, revealSettings } from './settings'

const encoded = (value: string): string => Buffer.from(`enc:${value}`).toString('base64')

describe('provider secret persistence', () => {
  beforeEach(() => {
    decryptString.mockReset()
    decryptString.mockImplementation((buffer: Buffer) =>
      buffer.toString('utf8').replace(/^enc:/, '')
    )
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
