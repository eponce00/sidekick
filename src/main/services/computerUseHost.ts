import { app, globalShortcut, Notification, powerMonitor } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { appState } from '../ipc/state'
import type { ComputerApp } from './computerUseApps'
import { ComputerUseService } from './computerUseService'
import { showTrustedDialog } from './trustedDialog'

async function askAllowForChat(
  title: string,
  message: string,
  detail: ReadonlyArray<string | null>,
  signal: AbortSignal
): Promise<boolean> {
  const window = appState.mainWindowRef
  const result = await showTrustedDialog(
    window && !window.isDestroyed() ? window : null,
    {
      type: 'warning',
      title,
      message,
      detail: detail.filter(Boolean).join('\n\n'),
      buttons: ['Don’t allow', 'Allow for this chat'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    { signal }
  )
  return result.response === 1
}

function confirmApp(target: ComputerApp, signal: AbortSignal, starting: boolean): Promise<boolean> {
  return askAllowForChat(
    'Let the agent use this app?',
    `Let the agent ${starting ? 'start, see' : 'see'} and operate ${target.name}?`,
    [
      target.path,
      'For this chat, the agent can read what this app shows, and click and type in it. Anything shown there, including personal details, goes to the model you selected.',
      target.access.kind === 'powerful' ? target.access.warning : null,
      target.access.kind === 'physical'
        ? 'This looks like software that controls real equipment. A wrong click or value could move a machine. Only allow this if that is safe right now.'
        : null,
      'Press Esc at any time to stop it.'
    ],
    signal
  )
}

function confirmTakeover(target: ComputerApp, signal: AbortSignal): Promise<boolean> {
  return askAllowForChat(
    'Let the agent use your mouse and keyboard?',
    `Let the agent use your real mouse and keyboard in ${target.name}?`,
    [
      `${target.name} ignores input sent in the background. For each such step, SideKick waits until you pause, brings ${target.name} to the front, uses your mouse and keyboard for a moment, and then goes back to what you had open.`,
      `If you type during that moment, your keys can land in ${target.name}, or the agent’s keys in another window.`,
      'Press Esc at any time to stop it.'
    ],
    signal
  )
}

function startApp(path: string): void {
  const child = spawn(path, [], { cwd: dirname(path), detached: true, stdio: 'ignore' })
  // A failed start shows up as no window appearing, which the agent is told about.
  child.on('error', () => undefined)
  child.unref()
}

/** Where the driver that ships with SideKick is. */
function bundledDriverPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'computer-driver', 'cua-driver.exe')
    : join(app.getAppPath(), 'build', 'computer-driver', 'cua-driver.exe')
}

let service: ComputerUseService | null = null

/**
 * The one service, with what only Electron can give it: the dialog, Esc, and the notification. Null
 * where the driver isn't there, which only a development checkout should ever see.
 */
export function computerUseService(): ComputerUseService | null {
  const driverPath = bundledDriverPath()
  if (!existsSync(driverPath)) return null
  service ??= new ComputerUseService({
    driverPath,
    dataFolder: () => join(app.getPath('userData'), 'computer-use'),
    confirmApp,
    confirmTakeover,
    userIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    startApp,
    armStop: (stop) => {
      globalShortcut.register('Escape', stop)
      return () => globalShortcut.unregister('Escape')
    },
    notifyActive: (appName) => {
      if (!Notification.isSupported()) return
      new Notification({
        title: 'SideKick is using an app',
        body: `The agent is operating ${appName}. Press Esc to stop it.`
      }).show()
    }
  })
  return service
}
