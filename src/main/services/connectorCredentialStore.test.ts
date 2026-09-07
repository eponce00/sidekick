import { describe, expect, it, vi } from 'vitest'
const { backend, nativeEncrypt, persistenceWrite } = vi.hoisted(() => ({
  backend: vi.fn(() => 'basic_text'),
  nativeEncrypt: vi.fn(),
  persistenceWrite: vi.fn()
}))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: backend,
    encryptString: nativeEncrypt,
    decryptString: vi.fn()
  }
}))
vi.mock('../ipc/state', () => ({ getStore: () => ({ get: () => ({}), set: persistenceWrite }) }))
import {
  ConnectorCredentialStore,
  createConnectorCredentialStore,
  ConnectorCredentialUnavailableError,
  type ConnectorCredentialPersistence,
  type ConnectorSecretCipher
} from './connectorCredentialStore'

function fixtures(available = true): {
  cipher: ConnectorSecretCipher
  persistence: ConnectorCredentialPersistence
  stored: () => Record<string, string>
} {
  let values: Record<string, string> = {}
  return {
    cipher: {
      isAvailable: () => available,
      encrypt: (value) => Buffer.from(`sealed:${value}`),
      decrypt: (value) =>
        Buffer.from(value)
          .toString()
          .replace(/^sealed:/, '')
    },
    persistence: {
      read: () => ({ ...values }),
      write: (next) => {
        values = { ...next }
      }
    },
    stored: () => values
  }
}

describe('ConnectorCredentialStore', () => {
  it('production factory refuses Linux basic_text for reads and writes', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    try {
      const store = createConnectorCredentialStore()
      await expect(store.set('connector:test', 'secret')).rejects.toBeInstanceOf(
        ConnectorCredentialUnavailableError
      )
      await expect(store.get('connector:test')).rejects.toBeInstanceOf(
        ConnectorCredentialUnavailableError
      )
      expect(nativeEncrypt).not.toHaveBeenCalled()
      expect(persistenceWrite).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('persists only encrypted material and round-trips the secret', async () => {
    const fixture = fixtures()
    const store = new ConnectorCredentialStore(fixture.cipher, fixture.persistence)

    await store.set('slack:workspace', 'access-token')

    expect(JSON.stringify(fixture.stored())).not.toContain('access-token')
    await expect(store.get('slack:workspace')).resolves.toBe('access-token')
  })

  it('fails closed when OS-backed encryption is unavailable', async () => {
    const fixture = fixtures(false)
    const store = new ConnectorCredentialStore(fixture.cipher, fixture.persistence)

    await expect(store.set('gmail:account', 'token')).rejects.toBeInstanceOf(
      ConnectorCredentialUnavailableError
    )
    expect(fixture.stored()).toEqual({})
  })

  it('allows encrypted credentials to be removed when decryption is unavailable', async () => {
    const available = fixtures()
    const writable = new ConnectorCredentialStore(available.cipher, available.persistence)
    await writable.set('slack:workspace', 'token')
    const unavailable = new ConnectorCredentialStore(
      { ...available.cipher, isAvailable: () => false },
      available.persistence
    )

    await expect(unavailable.delete('slack:workspace')).resolves.toBeUndefined()
    expect(available.stored()).toEqual({})
  })

  it('serializes concurrent refreshes without losing the newer value', async () => {
    const fixture = fixtures()
    const store = new ConnectorCredentialStore(fixture.cipher, fixture.persistence)
    await store.set('jira:site', 'zero')

    await Promise.all([
      store.modify('jira:site', async (current) => `${current}:one`),
      store.modify('jira:site', async (current) => `${current}:two`)
    ])

    await expect(store.get('jira:site')).resolves.toBe('zero:one:two')
  })
})
