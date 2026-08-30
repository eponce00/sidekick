import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  configureBrowserArtifactRoot,
  registerArtifactScheme,
  installArtifactProtocol
} from './bootstrap/artifactProtocol'
import { openApplicationDatabase } from './bootstrap/database'
import { createMainWindow } from './bootstrap/mainWindow'
import { initializeWorkspaceState } from './bootstrap/workspace'
import { registerAllHandlers } from './ipc'
import { closeMcpConnections } from './ipc/mcp'
import { appState } from './ipc/state'
import { shutdownCollaboration } from './ipc/collaboration'
import { shutdownAgentRuntime } from './ipc/agentRuns'
import { registerAppUpdateHandlers } from './ipc/appUpdates'
import { startWorkspaceWatcher } from './ipc/workspace'
import {
  configureCheckpointStorageRoot,
  recoverInterruptedCheckpointCaptures
} from './services/checkpoints'
import { CheckpointTitleStore } from './services/checkpointTitleStore'
import { installApplicationMenu } from './bootstrap/applicationMenu'
import appIcon from '../../resources/icon.png?asset'
import type { AppCommand } from '../shared/appCommands'
import { PRODUCT_IDENTITY } from '../shared/productIdentity'
import { AppUpdateService } from './services/appUpdateService'
import { isolatedE2EUserDataPath } from './bootstrap/applicationData'
import { revealWindow } from './bootstrap/windowActivation'

let appUpdateService: AppUpdateService | null = null
let applicationShutdown: Promise<void> | null = null
let shutdownReady = false
let quitAfterShutdownRequested = false

function closeApplicationDatabase(): void {
  if (appState.db?.open) appState.db.close()
  appState.db = null
}

function prepareApplicationShutdown(): Promise<void> {
  if (applicationShutdown) return applicationShutdown
  appUpdateService?.stop()
  shutdownCollaboration()
  applicationShutdown = Promise.allSettled([shutdownAgentRuntime(), closeMcpConnections()]).then(
    (results) => {
      for (const result of results) {
        if (result.status === 'rejected') console.error('[Shutdown] Cleanup failed:', result.reason)
      }
      shutdownReady = true
    }
  )
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

registerArtifactScheme()

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
    const titles = new CheckpointTitleStore(appState.db)
    const linkMessage = appState.db.prepare(
      `UPDATE messages SET checkpoint_hash = ?, checkpoint_workspace_root = ?
       WHERE id = ? AND conversation_id = ?`
    )
    for (const recovered of recoveredCaptures) {
      titles.recordCreated(
        recovered.workspaceRoot,
        recovered.checkpoint.hash,
        'Interrupted agent changes'
      )
      linkMessage.run(
        recovered.checkpoint.hash,
        recovered.workspaceRoot,
        recovered.agentMessageId,
        recovered.conversationId
      )
    }
    console.log(`[History] Recovered ${recoveredCaptures.length} interrupted file change set(s)`)
  }
  const workspacePath = await initializeWorkspaceState()

  electronApp.setAppUserModelId(PRODUCT_IDENTITY.appId)
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  ipcMain.on('ping', () => console.log('pong'))

  registerAllHandlers()
  appUpdateService = new AppUpdateService({
    disabledReason: process.argv.includes('--sidekick-packaged-smoke-test')
      ? 'development'
      : undefined
  })
  registerAppUpdateHandlers(appUpdateService)
  createMainWindow()
  const dispatchAppCommand = (command: AppCommand): void => {
    const target = BrowserWindow.getFocusedWindow() ?? appState.mainWindowRef
    if (!target || !revealWindow(target)) {
      const created = createMainWindow()
      created.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          if (!created.isDestroyed()) created.webContents.send('app:command', command)
        }, 0)
      })
      return
    }
    target.webContents.send('app:command', command)
  }
  installApplicationMenu(process.platform, PRODUCT_IDENTITY.productName, {
    'open-settings': () => dispatchAppCommand('open-settings'),
    'new-chat': () => dispatchAppCommand('new-chat'),
    'open-project': () => dispatchAppCommand('open-project'),
    'check-for-updates': () => void appUpdateService?.check()
  })
  startWorkspaceWatcher(workspacePath)
  appUpdateService.start()

  app.on('activate', () => {
    const target = appState.mainWindowRef ?? BrowserWindow.getAllWindows()[0]
    if (!revealWindow(target)) createMainWindow()
  })
}

void app
  .whenReady()
  .then(bootstrapApplication)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    console.error('[Startup] Application initialization failed:', error)
    dialog.showErrorBox('SideKick could not start', message)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownReady) {
    closeApplicationDatabase()
    return
  }
  event.preventDefault()
  if (quitAfterShutdownRequested) return
  quitAfterShutdownRequested = true
  void prepareApplicationShutdown()
    .catch((error) => console.error('[Shutdown] Cleanup failed:', error))
    .finally(() => {
      shutdownReady = true
      closeApplicationDatabase()
      app.quit()
    })
})
