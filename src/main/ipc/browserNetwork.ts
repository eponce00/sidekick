import { ipcMain } from 'electron'
import { browserNetworkApprovals } from '../services/browserNetworkApprovals'

export function registerBrowserNetworkHandlers(): void {
  ipcMain.handle('browserNetwork:list', () => browserNetworkApprovals.list())
  ipcMain.handle('browserNetwork:revoke', (_event, origin: unknown) =>
    typeof origin === 'string'
      ? browserNetworkApprovals.revoke(origin)
      : browserNetworkApprovals.list()
  )
}
