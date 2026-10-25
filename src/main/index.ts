import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  configureBrowserArtifactRoot,
  registerArtifactScheme,
  installArtifactProtocol
} from './bootstrap/artifactProtocol'
import { openApplicationDatabase } from './bootstrap/database'
import { createMainWindow, textScaleSetting } from './bootstrap/mainWindow'
import { stepTextScale } from './bootstrap/windowZoom'
import { initializeWorkspaceState } from './bootstrap/workspace'
import { registerAllHandlers } from './ipc'
import { closeMcpConnections } from './ipc/mcp'
import { appState } from './ipc/state'
import { activeAgentConversationCount, shutdownAgentRuntime } from './ipc/agentRuns'
import { setCompanionVoice, shutdownCompanion } from './ipc/companion'
import { sessionStatusService } from './ipc/sessionStatus'
import { shutdownWorktreeSetup } from './ipc/worktreeSetup'
import { shutdownUserTerminals } from './ipc/userTerminals'
import { registerAppUpdateHandlers } from './ipc/appUpdates'
import {
  configureCheckpointStorageRoot,
  recoverInterruptedCheckpointCaptures
} from './services/checkpoints'
import { installApplicationMenu } from './bootstrap/applicationMenu'
import appIcon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/tray.png?asset'
import type { AppCommand } from '../shared/appCommands'
import { PRODUCT_IDENTITY } from '../shared/productIdentity'
import { AppUpdateService } from './services/appUpdateService'
import { isolatedE2EUserDataPath } from './bootstrap/applicationData'
import { revealWindow } from './bootstrap/windowActivation'
import { registerVoiceHandlers } from './ipc/voice'
import { startScheduler, stopScheduler } from './ipc/schedules'
import { onSettingsSaved } from './ipc/settings'
import { VoiceService } from './services/voice/voiceService'
import { VoiceModelStore } from './services/voice/voiceModels'
import { confirmQuitWithActiveRuns, QuitGuard } from './bootstrap/quitConfirmation'
import { refreshAttentionBadge } from './services/attentionBadge'
import { isBrowserParkingWindow } from './services/browserViewHost'
import { SystemTray, type TraySnapshot } from './bootstrap/systemTray'
import { startControlEndpoint } from './control/controlService'
import { seedMcpApprovals } from './services/mcpServerTrust'
import { loadCredentialVault } from './services/credentialVaultInstance'

let appUpdateService: AppUpdateService | null = null
let voiceService: VoiceService | null = null
let stopControlEndpoint: (() => Promise<void>) | null = null
let applicationShutdown: Promise<void> | null = null
let shutdownReady = false
let quitAfterShutdownRequested = false
let systemTray: SystemTray | null = null
// The operating system is ending the session; windows must really close.
let sessionEnding = false
const TRAY_NOTICE_SHOWN_KEY = 'closeToTrayNoticeShown'
const quitGuard = new QuitGuard({
  activeConversationCount: activeAgentConversationCount,
  confirm: (count) => confirmQuitWithActiveRuns(count, appState.mainWindowRef)
})

function closeApplicationDatabase(): void {
  if (appState.db?.open) appState.db.close()
  appState.db = null
}

function prepareApplicationShutdown(): Promise<void> {
  if (applicationShutdown) return applicationShutdown
  appUpdateService?.stop()
  stopScheduler()
  voiceService?.dispose()
  shutdownUserTerminals()
  applicationShutdown = Promise.allSettled([
    stopControlEndpoint?.(),
    shutdownCompanion(),
    shutdownAgentRuntime(),
    closeMcpConnections(),
    shutdownWorktreeSetup()
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') console.error('[Shutdown] Cleanup failed:', result.reason)
    }
    shutdownReady = true
  })
  return applicationShutdown
}

const e2eUserDataPath = isolatedE2EUserDataPath(
  process.argv,
  process.env['SIDEKICK_E2E_USER_DATA_DIR']
)

if (is.dev || e2eUserDataPath) {
  // Electron's unsigned development binary has a different code identity from the packaged app.
  // Letting it touch the production-style Safe Storage entry makes macOS repeatedly request the
  // login Keychain password and can leave a stranded SecurityAgent dialog when the process exits.
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')
  app.setName(PRODUCT_IDENTITY.productName)
  app.setPath('userData', e2eUserDataPath ?? join(app.getPath('appData'), 'sidekick-dev'))
}

// Automated runs quit on their own schedule and cannot answer a dialog.
if (e2eUserDataPath || process.argv.includes('--sidekick-packaged-smoke-test')) quitGuard.allow()

let mainWindowOpened = false

/** Windows the user has open, leaving out the off-screen windows that hold browser pages. */
function userWindows(except?: BrowserWindow): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (other) =>
      other !== except &&
      !other.isDestroyed() &&
      other.isVisible() &&
      !isBrowserParkingWindow(other)
  )
}

/** The main window, or a new one when it was closed; never a browser page's hidden window. */
function showMainWindow(): void {
  if (!revealWindow(appState.mainWindowRef)) openMainWindow()
}

function storedSettings(): { closeToTray?: boolean } | undefined {
  return appState.store?.get('settings') as { closeToTray?: boolean } | undefined
}

/** Windows and Linux hide the window to the tray instead of closing it, unless SideKick is quitting. */
function hidesToTray(): boolean {
  return (
    process.platform !== 'darwin' &&
    Boolean(systemTray?.installed) &&
    !sessionEnding &&
    !quitAfterShutdownRequested &&
    !shutdownReady
  )
}

function hideToTray(window: BrowserWindow): void {
  window.hide()
  if (appState.store?.get(TRAY_NOTICE_SHOWN_KEY) === true) return
  appState.store?.set(TRAY_NOTICE_SHOWN_KEY, true)
  systemTray?.showHiddenNotice()
}

/** macOS always has its Dock menu; elsewhere the tray icon follows the close-to-tray setting. */
function syncSystemTray(): void {
  if (!systemTray) return
  if (process.platform === 'darwin' || storedSettings()?.closeToTray !== false) {
    systemTray.install()
  } else {
    systemTray.destroy()
  }
}

function workingConversationCount(): number {
  const counts = sessionStatusService()?.counts()
  return counts ? counts.working + counts.queued : 0
}

function waitingConversations(): TraySnapshot['waiting'] {
  const ids = sessionStatusService()?.waitingConversationIds() ?? []
  if (!ids.length || !appState.db?.open) return []
  const titleOf = appState.db.prepare('SELECT title FROM conversations WHERE id = ?')
  return ids.map((id) => ({
    id,
    title: (titleOf.get(id) as { title?: string } | undefined)?.title ?? ''
  }))
}

/**
 * On Windows and Linux closing the window hides it to the tray when that is on;
 * otherwise closing the last window quits, so it asks first too.
 */
function openMainWindow(): BrowserWindow {
  const window = createMainWindow()
  if (process.platform !== 'darwin') {
    window.on('close', (event) => {
      if (hidesToTray()) {
        event.preventDefault()
        hideToTray(window)
        return
      }
      if (userWindows(window).length) return
      if (quitGuard.intercept(() => (window.isDestroyed() ? app.quit() : window.close()))) {
        event.preventDefault()
      }
    })
    // Hidden browser windows keep Electron from seeing every window closed, which left
    // SideKick running with nothing to show and its icon unable to bring a window back.
    window.on('closed', () => {
      if (!userWindows().length) app.quit()
    })
  }
  // Windows is logging off or shutting down; it will not wait for a dialog.
  window.on('query-session-end', () => quitGuard.allow())
  window.on('session-end', () => {
    sessionEnding = true
    quitGuard.allow()
  })
  refreshAttentionBadge()
  return window
}

const ownsSingleInstance = e2eUserDataPath ? true : app.requestSingleInstanceLock()

if (!ownsSingleInstance) {
  app.quit()
} else {
  registerArtifactScheme()
  app.on('second-instance', () => {
    // During startup the first window is still on its way.
    if (mainWindowOpened) showMainWindow()
  })
}

async function bootstrapApplication(): Promise<void> {
  configureBrowserArtifactRoot(join(app.getPath('userData'), 'browser-artifacts'))
  await installArtifactProtocol()

  // Development runs use Electron.app, whose bundle icon is Electron's atom. Override the Dock
  // image at runtime so development and packaged SideKick builds have the same macOS identity.
  if (process.platform === 'darwin') app.dock?.setIcon(appIcon)

  const Store = (await import('electron-store')).default
  appState.store = new Store()
  appState.db = openApplicationDatabase(join(app.getPath('userData'), 'conversations.db'))
  configureCheckpointStorageRoot(join(app.getPath('userData'), 'history'))
  const recoveredCaptures = await recoverInterruptedCheckpointCaptures()
  if (recoveredCaptures.length) {
    const linkMessage = appState.db.prepare(
      `UPDATE messages SET checkpoint_hash = ?, checkpoint_workspace_root = ?
       WHERE id = ? AND conversation_id = ?`
    )
    for (const recovered of recoveredCaptures) {
      linkMessage.run(
        recovered.checkpoint.hash,
        recovered.workspaceRoot,
        recovered.agentMessageId,
        recovered.conversationId
      )
    }
    console.log(`[History] Recovered ${recoveredCaptures.length} interrupted file change set(s)`)
  }
  await initializeWorkspaceState()

  electronApp.setAppUserModelId(PRODUCT_IDENTITY.appId)
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  ipcMain.on('ping', () => console.log('pong'))

  seedMcpApprovals()
  // Before any agent runs, so stored values are redacted from the first output on.
  loadCredentialVault()
  registerAllHandlers()
  appUpdateService = new AppUpdateService({
    beforeQuit: async () => {
      // The user already agreed to restart when installing the update.
      quitGuard.allow()
      await prepareApplicationShutdown()
      closeApplicationDatabase()
    },
    disabledReason: process.argv.includes('--sidekick-packaged-smoke-test')
      ? 'development'
      : undefined,
    automaticChecks: () =>
      (appState.store?.get('settings') as { automaticUpdateChecks?: boolean } | undefined)
        ?.automaticUpdateChecks !== false
  })
  registerAppUpdateHandlers(appUpdateService)
  // Smoke and end-to-end runs must not start a large background download.
  const voiceDownloadsAllowed =
    !process.argv.includes('--sidekick-packaged-smoke-test') && !e2eUserDataPath
  const voiceEnabled = (): boolean =>
    voiceDownloadsAllowed &&
    (appState.store?.get('settings') as { voiceEnabled?: boolean } | undefined)?.voiceEnabled !==
      false
  voiceService = new VoiceService({
    store: new VoiceModelStore(join(app.getPath('userData'), 'voice-models')),
    enabled: voiceEnabled()
  })
  registerVoiceHandlers(voiceService)
  setCompanionVoice(voiceService)
  onSettingsSaved(() => voiceService?.setEnabled(voiceEnabled()))
  openMainWindow()
  mainWindowOpened = true
  powerMonitor.on('shutdown', () => {
    sessionEnding = true
    quitGuard.allow()
  })
  const sendToWindow = (channel: 'app:command' | 'app:openConversation', value: string): void => {
    const target = BrowserWindow.getFocusedWindow() ?? appState.mainWindowRef
    if (!target || !revealWindow(target)) {
      const created = openMainWindow()
      created.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          if (!created.isDestroyed()) created.webContents.send(channel, value)
        }, 0)
      })
      return
    }
    target.webContents.send(channel, value)
  }
  const dispatchAppCommand = (command: AppCommand): void => sendToWindow('app:command', command)
  installApplicationMenu(process.platform, PRODUCT_IDENTITY.productName, {
    'open-settings': () => dispatchAppCommand('open-settings'),
    'new-chat': () => dispatchAppCommand('new-chat'),
    'open-project': () => dispatchAppCommand('open-project'),
    'check-for-updates': () => void appUpdateService?.check(),
    'text-larger': () => stepTextScale(textScaleSetting, 'in'),
    'text-smaller': () => stepTextScale(textScaleSetting, 'out'),
    'text-reset': () => stepTextScale(textScaleSetting, 'reset')
  })
  const updates = appUpdateService
  const installUpdate = (): void => void updates.install()
  systemTray = new SystemTray({
    platform: process.platform,
    productName: PRODUCT_IDENTITY.productName,
    iconPath: appIcon,
    trayIconPath: trayIcon,
    snapshot: () => ({
      workingCount: workingConversationCount(),
      waiting: waitingConversations(),
      update: updates.getState()
    }),
    actions: {
      open: showMainWindow,
      newChat: () => dispatchAppCommand('new-chat'),
      openConversation: (id) => sendToWindow('app:openConversation', id),
      openSettings: () => dispatchAppCommand('open-settings'),
      checkForUpdates: () => void updates.check(),
      // Restarting stops working agents, so it asks first like any other quit.
      installUpdate: () => {
        if (!quitGuard.intercept(installUpdate)) installUpdate()
      },
      openRelease: () => void updates.openRelease(),
      quit: () => app.quit()
    }
  })
  syncSystemTray()
  onSettingsSaved(syncSystemTray)
  sessionStatusService()?.onChange(() => systemTray?.refresh())
  updates.subscribe(() => systemTray?.refresh())
  appUpdateService.start()
  startScheduler({ openConversation: (id) => sendToWindow('app:openConversation', id) })
  // Only the instance holding the single-instance lock gets here, so one endpoint serves the
  // profile; a second launch just raises this window.
  startControlEndpoint()
    .then((stop) => {
      if (applicationShutdown) void stop()
      else stopControlEndpoint = stop
    })
    .catch((error: unknown) => console.error('[Control] The sidekick CLI is unavailable:', error))

  app.on('activate', showMainWindow)
}

if (ownsSingleInstance) {
  void app
    .whenReady()
    .then(bootstrapApplication)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      console.error('[Startup] Application initialization failed:', error)
      dialog.showErrorBox('SideKick could not start', message)
      app.quit()
    })
}

if (ownsSingleInstance) {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Windows otherwise leaves a dead icon in the notification area until the pointer passes over it.
  app.on('will-quit', () => systemTray?.destroy())

  app.on('before-quit', (event) => {
    if (shutdownReady) {
      closeApplicationDatabase()
      return
    }
    event.preventDefault()
    if (quitAfterShutdownRequested) return
    if (quitGuard.intercept(() => app.quit())) return
    quitAfterShutdownRequested = true
    void prepareApplicationShutdown()
      .catch((error) => console.error('[Shutdown] Cleanup failed:', error))
      .finally(() => {
        shutdownReady = true
        closeApplicationDatabase()
        app.quit()
      })
  })
}
