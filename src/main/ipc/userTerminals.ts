import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { UserTerminalEvent } from '../../shared/userTerminals'
import { panelWindowFor } from '../bootstrap/panelWindows'
import { ensureChatFolder } from '../services/chatFolders'
import { ProjectStore } from '../services/projectStore'
import { UserTerminalService } from '../services/userTerminals'
import { appState, getDb } from './state'

let service: UserTerminalService | null = null

/** The app's own documents: the main window and the panels torn out of it. */
function isAppDocument(contents: WebContents): boolean {
  return contents === appState.mainWindowRef?.webContents || Boolean(panelWindowFor(contents))
}

/** A shell runs anything typed into it, so only the app's own top-level page may drive one. */
function assertAppSender(event: IpcMainInvokeEvent): void {
  if (!isAppDocument(event.sender) || event.senderFrame !== event.sender.mainFrame)
    throw new Error('Terminals are only available from the SideKick window')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** What the user types and sees goes only to the app's own windows. */
function publish(event: UserTerminalEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if (isAppDocument(window.webContents)) window.webContents.send('userTerminal:event', event)
  }
}

function terminals(): UserTerminalService {
  service ??= new UserTerminalService({
    publish,
    folderFor: (conversationId) => {
      const context = new ProjectStore(getDb()).getConversationContext(conversationId)
      if (context.chatFolder && context.workspaceRoot) ensureChatFolder(context.workspaceRoot)
      return context.workspaceRoot
    }
  })
  return service
}

/** The user's own shells, kept apart from the agent's command handlers in `agentRuns.ts`. */
export function registerUserTerminalHandlers(): void {
  ipcMain.handle('userTerminal:list', (event) => {
    assertAppSender(event)
    return terminals().list()
  })
  ipcMain.handle('userTerminal:create', (event, raw: unknown) => {
    assertAppSender(event)
    const { conversationId, cols, rows } = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >
    return terminals().create({
      conversationId: validId(conversationId) ? conversationId : null,
      cols,
      rows
    })
  })
  ipcMain.handle('userTerminal:read', (event, id: unknown, offset: unknown) => {
    assertAppSender(event)
    if (!validId(id)) return null
    const start = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, offset) : 0
    return terminals().read(id, start) ?? null
  })
  ipcMain.handle('userTerminal:write', (event, id: unknown, data: unknown) => {
    assertAppSender(event)
    return { written: validId(id) && terminals().write(id, data) }
  })
  ipcMain.handle('userTerminal:resize', (event, id: unknown, cols: unknown, rows: unknown) => {
    assertAppSender(event)
    return { resized: validId(id) && terminals().resize(id, cols, rows) }
  })
  ipcMain.handle('userTerminal:close', (event, id: unknown) => {
    assertAppSender(event)
    return { closed: validId(id) && terminals().close(id) }
  })
}

export function shutdownUserTerminals(): void {
  service?.closeAll()
}
