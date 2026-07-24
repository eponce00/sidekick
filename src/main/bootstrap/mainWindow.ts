import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { appState } from '../ipc/state'
import { browserPermissionOperation } from '../../shared/permissions'
import { permissionBroker } from '../services/permissionBroker'
import { installNativeTextContextMenu } from './nativeTextContextMenu'
import { desktopPlatform } from '../../shared/platform'
import { mainWindowChrome } from './windowChrome'
import { installWindowsTitleBarMenu } from './windowsTitleBarMenu'
import { resolveSpellCheckerLanguages } from './spellCheckerLanguages'
import { parseStoredWindowState, visibleWindowBounds } from './windowState'

const WINDOW_STATE_KEY = 'desktopWindowStateV1'

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function rendererUrl(): string {
  return is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

function isTrustedRendererNavigation(value: string): boolean {
  try {
    const target = new URL(value)
    const trusted = new URL(rendererUrl())
    if (is.dev) return target.origin === trusted.origin
    return target.protocol === 'file:' && target.pathname === trusted.pathname
  } catch {
    return false
  }
}

export function createMainWindow(): BrowserWindow {
  const platform = desktopPlatform(process.platform)
  const storedWindowState = parseStoredWindowState(appState.store?.get(WINDOW_STATE_KEY))
  const restoredBounds = visibleWindowBounds(
    storedWindowState,
    screen.getAllDisplays().map(({ workArea }) => workArea)
  )
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 720,
    minHeight: 520,
    ...(restoredBounds || {}),
    show: false,
    autoHideMenuBar: platform !== 'macos',
    ...mainWindowChrome(platform),
    title: 'SideKick',
    backgroundColor: '#0e1115',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  })

  if (platform !== 'macos') {
    const spellCheckerLanguages = resolveSpellCheckerLanguages(
      app.getPreferredSystemLanguages(),
      mainWindow.webContents.session.availableSpellCheckerLanguages
    )
    if (spellCheckerLanguages.length > 0) {
      mainWindow.webContents.session.setSpellCheckerLanguages(spellCheckerLanguages)
    }
  }

  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  const openExternalWithPermission = async (url: string): Promise<void> => {
    if (!isSafeExternalUrl(url)) return
    const operation = browserPermissionOperation('navigate', url, 'auto')
    const authorization = await permissionBroker.authorize(operation, mainWindow.webContents)
    if (!authorization.approved || !authorization.token) return
    permissionBroker.consume(authorization.token, operation)
    await shell.openExternal(url)
  }
  installNativeTextContextMenu(mainWindow, { openLink: openExternalWithPermission })
  if (platform === 'windows') installWindowsTitleBarMenu(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void openExternalWithPermission(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererNavigation(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void openExternalWithPermission(url)
    }
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (platform !== 'macos') {
    const publishMaximizedState = (): void => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
      }
    }
    mainWindow.on('maximize', publishMaximizedState)
    mainWindow.on('unmaximize', publishMaximizedState)
  }

  if (platform === 'macos') {
    const publishFullScreenState = (): void => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window:fullscreen-changed', mainWindow.isFullScreen())
      }
    }
    mainWindow.on('enter-full-screen', publishFullScreenState)
    mainWindow.on('leave-full-screen', publishFullScreenState)
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const persistWindowState = (): void => {
    if (mainWindow.isDestroyed()) return
    const bounds = mainWindow.getNormalBounds()
    appState.store?.set(WINDOW_STATE_KEY, {
      ...bounds,
      maximized: platform !== 'macos' && mainWindow.isMaximized()
    })
  }
  const scheduleWindowStatePersistence = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistWindowState()
    }, 250)
  }
  mainWindow.on('move', scheduleWindowStatePersistence)
  mainWindow.on('resize', scheduleWindowStatePersistence)
  mainWindow.on('maximize', scheduleWindowStatePersistence)
  mainWindow.on('unmaximize', scheduleWindowStatePersistence)

  mainWindow.on('ready-to-show', () => {
    if (platform !== 'macos' && storedWindowState?.maximized) mainWindow.maximize()
    mainWindow.show()
  })
  mainWindow.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer)
    appState.mainWindowRef = null
    appState.workspaceWatcher?.close()
    appState.workspaceWatcher = null
  })
  mainWindow.on('close', persistWindowState)
  appState.mainWindowRef = mainWindow

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}
