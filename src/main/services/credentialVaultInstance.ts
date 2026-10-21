import { safeStorage } from 'electron'
import { getStore } from '../ipc/state'
import { CredentialVault } from './credentialVault'
import { isSecureCredentialStorageAvailable } from './secureCredentialStorage'

/**
 * Top-level store keys, outside `settings`: a Settings save rebuilds `settings` from the
 * renderer's copy, and the public settings projection would pass an unknown key to the renderer.
 */
const VAULT_KEY = 'credentialVault'
const EVENTS_KEY = 'credentialEvents'

let vault: CredentialVault | null = null

/** The app's credential vault, opened on first use. */
export function getCredentialVault(): CredentialVault {
  if (vault) return vault
  const store = getStore()
  vault = new CredentialVault(
    {
      isAvailable: () => isSecureCredentialStorageAvailable(),
      seal: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
      open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    },
    {
      read: () => store.get(VAULT_KEY),
      write: (file) => store.set(VAULT_KEY, file),
      readEvents: () => store.get(EVENTS_KEY),
      writeEvents: (events) => store.set(EVENTS_KEY, events)
    }
  )
  return vault
}

/**
 * Opens the vault at launch so its values are redacted from the first tool output on. A failure
 * leaves entries listed as needing their values again rather than stopping SideKick.
 */
export function loadCredentialVault(): void {
  try {
    getCredentialVault().load()
  } catch (error) {
    console.warn(
      '[Credentials] Could not open stored credentials:',
      error instanceof Error ? error.name : 'unknown error'
    )
  }
}
