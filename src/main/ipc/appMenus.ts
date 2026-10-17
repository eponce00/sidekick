import { ipcMain } from 'electron'
import { chooseAppMenuItem, dismissAppMenu } from '../services/appMenus'

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100
}

/** The window reports a choice in a menu the main process opened for it, by token. */
export function registerAppMenuHandlers(): void {
  ipcMain.handle('menus:choose', (event, token: unknown, itemId: unknown) => {
    if (!validToken(token) || !validToken(itemId)) throw new Error('Invalid menu choice')
    chooseAppMenuItem(event.sender, token, itemId)
  })
  ipcMain.handle('menus:dismiss', (event, token: unknown) => {
    if (!validToken(token)) throw new Error('Invalid menu')
    dismissAppMenu(event.sender, token)
  })
}
