import { app, BrowserWindow, screen, systemPreferences } from 'electron'
import { join } from 'path'
import icon from '../../../resources/icon.png?asset'
import { appState } from '../ipc/state'
import { desktopPlatform } from '../../shared/platform'
import { mainWindowChrome } from './windowChrome'
import { resolveSpellCheckerLanguages } from './spellCheckerLanguages'
import { parseStoredWindowState, visibleWindowBounds } from './windowState'
import type { TextScaleSetting } from './windowZoom'
import { installAppWindowGuards, isTrustedRendererNavigation, loadAppPage } from './appWindowGuards'
import { closePanelWindows } from './panelWindows'
import { loadStoredSettings, onSettingsSaved, saveSettingsChanges } from '../ipc/settings'
import { broadcastSettingsChanged } from '../control/controlService'

const WINDOW_STATE_KEY = 'desktopWindowStateV1'

/** The text-size setting as stored; a change from anywhere reaches every window. */
export const textScaleSetting: TextScaleSetting = {
  current: () => loadStoredSettings().textScale,
  save: (textScale) => broadcastSettingsChanged(saveSettingsChanges({ textScale })),
  onChanged: (listener) => onSettingsSaved(listener)
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
    backgroundColor: '#131313',
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

  // The app's own page may use the microphone, audio only, for local dictation.
  // Everything else stays refused.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const audioOnly =
        permission === 'media' &&
        'mediaTypes' in details &&
        Boolean(details.mediaTypes?.length) &&
        details.mediaTypes!.every((type) => type === 'audio')
      if (
        !audioOnly ||
        contents !== mainWindow.webContents ||
        !isTrustedRendererNavigation(details.requestingUrl)
      ) {
        callback(false)
        return
      }
      if (process.platform !== 'darwin') {
        callback(true)
        return
      }
      void systemPreferences
        .askForMediaAccess('microphone')
        .then(callback)
        .catch(() => callback(false))
    }
  )
  installAppWindowGuards(mainWindow, platform, textScaleSetting)

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
    // A tab in a window of its own belongs to this window's panel.
    closePanelWindows()
  })
  mainWindow.on('close', persistWindowState)
  appState.mainWindowRef = mainWindow

  loadAppPage(mainWindow)
  return mainWindow
}
