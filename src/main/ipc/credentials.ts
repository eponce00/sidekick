import { BrowserWindow, ipcMain } from 'electron'
import {
  validateCredentialInput,
  type CredentialRequest,
  type CredentialSaveResult
} from '../../shared/credentials'
import { revealWindow } from '../bootstrap/windowActivation'
import { CredentialUnavailableError } from '../services/credentialVault'
import { getCredentialVault } from '../services/credentialVaultInstance'
import { showTrustedDialog } from '../services/trustedDialog'
import { appState } from './state'

function broadcastChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('credentials:changed')
  }
}

function parentWindow(sender: Electron.WebContents): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(sender)
  return window && !window.isDestroyed() ? window : null
}

/** Opens Settings at Credentials; the agent never fills the form, the user does. */
export function openCredentialEditor(request: CredentialRequest): boolean {
  const window = appState.mainWindowRef
  if (!window || window.isDestroyed()) return false
  revealWindow(window)
  window.webContents.send('app:openCredential', request)
  return true
}

export function registerCredentialHandlers(): void {
  ipcMain.handle('credentials:status', () => getCredentialVault().status())
  ipcMain.handle('credentials:list', () => getCredentialVault().list())
  ipcMain.handle('credentials:events', (_event, credentialId: unknown) =>
    getCredentialVault().events(typeof credentialId === 'string' ? credentialId : undefined)
  )

  ipcMain.handle('credentials:save', (_event, raw: unknown): CredentialSaveResult => {
    const vault = getCredentialVault()
    const id =
      raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
        ? (raw as { id: string }).id
        : undefined
    const existing = id ? vault.get(id) : undefined
    if (id && !existing) return { ok: false, error: 'That credential no longer exists.' }
    const validated = validateCredentialInput(raw, existing)
    if ('error' in validated) return { ok: false, error: validated.error }
    try {
      const credential = vault.save(validated.input)
      broadcastChanged()
      return { ok: true, credential, credentials: vault.list() }
    } catch (error) {
      if (error instanceof CredentialUnavailableError) return { ok: false, error: error.message }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'The credential could not be saved.'
      }
    }
  })

  ipcMain.handle('credentials:delete', async (event, id: unknown) => {
    const vault = getCredentialVault()
    const existing = typeof id === 'string' ? vault.get(id) : undefined
    if (!existing) return { deleted: false, credentials: vault.list() }
    const answer = await showTrustedDialog(parentWindow(event.sender), {
      type: 'warning',
      title: 'Delete credential',
      message: `Delete ${existing.alias}?`,
      detail:
        'The agent can no longer use it, including in chats that are running now. This cannot be undone; to use it again, add it again.',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    const deleted = answer.response === 1 && vault.delete(existing.id)
    if (deleted) broadcastChanged()
    return { deleted, credentials: vault.list() }
  })
}
