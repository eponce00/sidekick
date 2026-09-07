import { BrowserWindow, ipcMain } from 'electron'
import type { AppUpdateState } from '../../shared/appUpdates'
import type { AppUpdateService } from '../services/appUpdateService'
import { appState } from './state'

function publish(state: AppUpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('appUpdates:state', state)
  }
}

export function registerAppUpdateHandlers(service: AppUpdateService): () => void {
  ipcMain.handle('appUpdates:getState', () => service.getState())
  ipcMain.handle('appUpdates:check', () => service.check())
  ipcMain.handle('appUpdates:install', (event) => {
    if (
      event.sender !== appState.mainWindowRef?.webContents ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Only the SideKick application can install updates')
    }
    return service.install()
  })
  ipcMain.handle('appUpdates:openRelease', () => service.openRelease())
  return service.subscribe(publish)
}
