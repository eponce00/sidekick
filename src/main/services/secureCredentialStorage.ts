import { safeStorage } from 'electron'

/** Electron's Linux basic_text backend is not OS-protected credential storage. */
export function isSecureCredentialStorageAvailable(platform = process.platform): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (platform !== 'linux') return true
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
      safeStorage.getSelectedStorageBackend()
    )
  } catch {
    return false
  }
}
