import { shell, type BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { browserPermissionOperation } from '../../shared/permissions'
import { permissionBroker } from '../services/permissionBroker'
import { installNativeTextContextMenu } from './nativeTextContextMenu'
import type { DesktopPlatform } from '../../shared/platform'
import { installWindowsTitleBarMenu } from './windowsTitleBarMenu'
import { installWindowZoom, type TextScaleSetting } from './windowZoom'

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function rendererUrl(): string {
  return is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

export function isTrustedRendererNavigation(value: string): boolean {
  try {
    const target = new URL(value)
    const trusted = new URL(rendererUrl())
    if (is.dev) return target.origin === trusted.origin
    return target.protocol === 'file:' && target.pathname === trusted.pathname
  } catch {
    return false
  }
}

/** Loads SideKick's own page in a window, with a query for what that window shows. */
export function loadAppPage(window: BrowserWindow, query: Record<string, string> = {}): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

/**
 * What every window of SideKick's own page gets: it stays on that page, opens links outside only
 * with permission, never attaches webviews, follows the app's text size, and reports its
 * maximized and full-screen state to its title bar.
 */
export function installAppWindowGuards(
  window: BrowserWindow,
  platform: DesktopPlatform,
  textScale: TextScaleSetting
): void {
  const contents = window.webContents
  const openExternalWithPermission = async (url: string): Promise<void> => {
    if (!isSafeExternalUrl(url)) return
    const operation = browserPermissionOperation('navigate', url, 'auto')
    const authorization = await permissionBroker.authorize(operation, contents)
    if (!authorization.approved || !authorization.token) return
    permissionBroker.consume(authorization.token, operation)
    await shell.openExternal(url)
  }
  installNativeTextContextMenu(window, { openLink: openExternalWithPermission })
  installWindowZoom(window, textScale)
  if (platform === 'windows') installWindowsTitleBarMenu(window)
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalWithPermission(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererNavigation(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void openExternalWithPermission(url)
    }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())

  if (platform !== 'macos') {
    const publishMaximizedState = (): void => {
      if (!window.isDestroyed()) contents.send('window:maximized-changed', window.isMaximized())
    }
    window.on('maximize', publishMaximizedState)
    window.on('unmaximize', publishMaximizedState)
  } else {
    const publishFullScreenState = (): void => {
      if (!window.isDestroyed()) contents.send('window:fullscreen-changed', window.isFullScreen())
    }
    window.on('enter-full-screen', publishFullScreenState)
    window.on('leave-full-screen', publishFullScreenState)
  }
}
