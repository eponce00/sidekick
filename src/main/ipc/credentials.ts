import { BrowserWindow, ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import {
  validateCredentialInput,
  type CredentialRequest,
  type CredentialSaveResult,
  type CredentialUseContext
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

/** Which project a chat is in, and whether the user or something else started it. */
export function conversationCredentialContext(
  db: Database.Database,
  conversationId: string | undefined
): CredentialUseContext | undefined {
  if (!conversationId) return undefined
  const row = db
    .prepare('SELECT project_id, started_by_kind FROM conversations WHERE id = ?')
    .get(conversationId) as
    | { project_id: string | null; started_by_kind: string | null }
    | undefined
  if (!row) return undefined
  return {
    projectId: row.project_id,
    background: Boolean(row.started_by_kind) && row.started_by_kind !== 'user'
  }
}

export function registerCredentialHandlers(): void {
  ipcMain.handle('credentials:status', () => getCredentialVault().status())
  ipcMain.handle('credentials:list', () => getCredentialVault().list())
  ipcMain.handle('credentials:events', (_event, credentialId: unknown) =>
    getCredentialVault().events(typeof credentialId === 'string' ? credentialId : undefined)
  )

  ipcMain.handle('credentials:save', async (event, raw: unknown): Promise<CredentialSaveResult> => {
    const vault = getCredentialVault()
    const id =
      raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
        ? (raw as { id: string }).id
        : undefined
    const existing = id ? vault.get(id) : undefined
    if (id && !existing) return { ok: false, error: 'That credential no longer exists.' }
    const validated = validateCredentialInput(raw, existing)
    if ('error' in validated) return { ok: false, error: validated.error }
    // The renderer is not trusted to widen where a stored value may go on its own.
    const widening = vault.widening(validated.input)
    if (widening.length) {
      const answer = await showTrustedDialog(parentWindow(event.sender), {
        type: 'warning',
        title: 'Widen a credential',
        message: `Let the agent use ${existing?.alias ?? validated.input.alias} more widely?`,
        detail: [
          ...widening.map((change) => `• ${change}`),
          'SideKick still never shows the value to the agent.'
        ].join('\n'),
        buttons: ['Cancel', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (answer.response !== 1) return { ok: false, error: 'Not saved.', cancelled: true }
    }
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
