import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { appState } from './state'
import { isPanelWindowApp, type PanelWindowEntry } from '../../shared/panelWindows'
import {
  dockPanelWindow,
  focusPanelWindow,
  openPanelWindow,
  panelWindowEntries
} from '../bootstrap/panelWindows'
import { textScaleSetting } from '../bootstrap/mainWindow'

function fromMainWindow(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return (
    event.sender === appState.mainWindowRef?.webContents &&
    event.senderFrame === event.sender.mainFrame
  )
}

function entryFrom(raw: unknown): PanelWindowEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const { app, conversationId } = raw as Record<string, unknown>
  return isPanelWindowApp(app) &&
    typeof conversationId === 'string' &&
    conversationId.length > 0 &&
    conversationId.length <= 200
    ? { app, conversationId }
    : null
}

/** Opening and focusing come from the main window's panel; putting back, from the window itself. */
export function registerPanelWindowHandlers(): void {
  ipcMain.handle('panelWindows:open', (event, raw: unknown) => {
    const entry = entryFrom(raw)
    if (!fromMainWindow(event) || !entry) return false
    const { x, y } = raw as { x?: unknown; y?: unknown }
    openPanelWindow(
      entry,
      {
        ...(typeof x === 'number' ? { x } : {}),
        ...(typeof y === 'number' ? { y } : {})
      },
      textScaleSetting
    )
    return true
  })
  ipcMain.handle('panelWindows:list', () => panelWindowEntries())
  ipcMain.handle('panelWindows:focus', (event, raw: unknown) => {
    const entry = entryFrom(raw)
    return Boolean(fromMainWindow(event) && entry && focusPanelWindow(entry))
  })
  ipcMain.on('panelWindows:dock', (event) => {
    if (event.senderFrame === event.sender.mainFrame) dockPanelWindow(event.sender)
  })
}
