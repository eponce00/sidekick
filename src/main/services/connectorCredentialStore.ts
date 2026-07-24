import { safeStorage } from 'electron'
import { getStore } from '../ipc/state'

export interface ConnectorSecretCipher {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

export interface ConnectorCredentialPersistence {
  read(): Record<string, string>
  write(credentials: Record<string, string>): void
}

export class ConnectorCredentialUnavailableError extends Error {
  constructor() {
    super('Secure credential storage is unavailable on this device.')
    this.name = 'ConnectorCredentialUnavailableError'
  }
}

function validateCredentialId(id: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(id)) throw new Error('Invalid connector credential ID.')
}

/**
 * A fail-closed, serialized secret store for connector OAuth tokens and client credentials.
 * Persistence contains encrypted blobs only; callers never receive a plaintext fallback.
 */
export class ConnectorCredentialStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly cipher: ConnectorSecretCipher,
    private readonly persistence: ConnectorCredentialPersistence
  ) {}

  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) throw new ConnectorCredentialUnavailableError()
  }

  async get(id: string): Promise<string | undefined> {
    validateCredentialId(id)
    await this.queue
    this.assertAvailable()
    const encoded = this.persistence.read()[id]
    if (!encoded) return undefined
    return this.cipher.decrypt(Buffer.from(encoded, 'base64'))
  }

  set(id: string, value: string): Promise<void> {
    validateCredentialId(id)
    const operation = this.queue.then(() => {
      this.assertAvailable()
      const encrypted = this.cipher.encrypt(value)
      this.persistence.write({
        ...this.persistence.read(),
        [id]: Buffer.from(encrypted).toString('base64')
      })
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  delete(id: string): Promise<void> {
    validateCredentialId(id)
    const operation = this.queue.then(() => {
      const credentials = { ...this.persistence.read() }
      delete credentials[id]
      this.persistence.write(credentials)
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  /** Serializes token refreshes so concurrent requests cannot overwrite newer credentials. */
  modify(id: string, update: (current: string | undefined) => Promise<string>): Promise<void> {
    validateCredentialId(id)
    const operation = this.queue.then(async () => {
      this.assertAvailable()
      const credentials = this.persistence.read()
      const current = credentials[id]
        ? this.cipher.decrypt(Buffer.from(credentials[id], 'base64'))
        : undefined
      const next = await update(current)
      credentials[id] = Buffer.from(this.cipher.encrypt(next)).toString('base64')
      this.persistence.write({ ...credentials })
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}

export function createConnectorCredentialStore(): ConnectorCredentialStore {
  const store = getStore()
  return new ConnectorCredentialStore(
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
    },
    {
      read: () => {
        const value = store.get('connectorCredentials', {})
        return value && typeof value === 'object' && !Array.isArray(value)
          ? ({ ...value } as Record<string, string>)
          : {}
      },
      write: (credentials) => store.set('connectorCredentials', credentials)
    }
  )
}
