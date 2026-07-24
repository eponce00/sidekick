import { BrowserWindow, clipboard, ipcMain, Notification } from 'electron'
import { readFileSync } from 'fs'
import icon from '../../../resources/icon.png?asset'
import iconDark from '../../../resources/icon-dark.png?asset'
import iconLight from '../../../resources/icon-light.png?asset'
import {
  normalizeDesktopNotificationBody,
  type DesktopNotificationRequest
} from '../../shared/desktopNotifications'

export function registerWindowHandlers(): void {
  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    if (typeof text !== 'string' || text.length > 4_000_000) {
      return { success: false, error: 'Clipboard text is invalid or too large' }
    }
    try {
      clipboard.writeText(text)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Could not write to clipboard'
      }
    }
  })

  // Window control handlers for custom title bar
  ipcMain.on('window:minimize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    window?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window?.isMaximized()) {
      window.unmaximize()
    } else {
      window?.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    window?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window?.isMaximized() ?? false
  })

  ipcMain.handle('window:isFullScreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window?.isFullScreen() ?? false
  })

  ipcMain.handle('notification:show', (event, request: DesktopNotificationRequest) => {
    if (!Notification.isSupported()) return { ok: false, error: 'Notifications are not supported' }
    const mainWindow = BrowserWindow.fromWebContents(event.sender)
    const notification = new Notification({
      title: 'SideKick',
      body: normalizeDesktopNotificationBody(request?.body),
      silent: request?.silent !== false,
      icon: process.platform === 'darwin' ? undefined : icon
    })
    notification.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })
    notification.on('failed', (_event, error) => {
      console.warn('[Notification] Native notification failed:', error)
    })
    notification.show()
    return { ok: true }
  })

  // Get icon as data URL for renderer (theme-aware)
  ipcMain.handle('app:getIconPath', (_, theme?: 'dark' | 'light') => {
    try {
      let iconPath: string
      if (theme === 'dark') {
        iconPath = iconLight
      } else if (theme === 'light') {
        iconPath = iconDark
      } else {
        iconPath = icon
      }
      const iconBuffer = readFileSync(iconPath)
      const base64 = iconBuffer.toString('base64')
      return `data:image/png;base64,${base64}`
    } catch (error) {
      console.error('Failed to load icon:', error)
      return ''
    }
  })
}
