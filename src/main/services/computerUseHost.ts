import { app, globalShortcut, Notification } from 'electron'
import { join } from 'path'
import { appState } from '../ipc/state'
import type { ComputerApp } from './computerUseApps'
import { ComputerUseService } from './computerUseService'
import { showTrustedDialog } from './trustedDialog'

async function confirmApp(target: ComputerApp, signal: AbortSignal): Promise<boolean> {
  const physical = target.access.kind === 'physical'
  const window = appState.mainWindowRef
  const result = await showTrustedDialog(
    window && !window.isDestroyed() ? window : null,
    {
      type: 'warning',
      title: 'Let the agent use this app?',
      message: `Let the agent see and operate ${target.name}?`,
      detail: [
        target.path,
        'For this chat, the agent can read what this app shows, and click and type in it. Anything shown there, including personal details, goes to the model you selected.',
        physical
          ? 'This looks like software that controls real equipment. A wrong click or value could move a machine. Only allow this if that is safe right now.'
          : null,
        'Press Esc at any time to stop it.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      buttons: ['Don’t allow', 'Allow for this chat'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    { signal }
  )
  return result.response === 1
}

let service: ComputerUseService | null = null

/** The one service, with what only Electron can give it: the dialog, Esc, and the notification. */
export function computerUseService(driverPath: () => string | undefined): ComputerUseService {
  service ??= new ComputerUseService({
    driverPath,
    dataFolder: () => join(app.getPath('userData'), 'computer-use'),
    confirmApp,
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
