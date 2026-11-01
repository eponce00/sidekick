import { app, globalShortcut, Notification, powerMonitor } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { appState } from '../ipc/state'
import type { ComputerApp } from './computerUseApps'
import { ComputerUseHighlight } from './computerUseHighlight'
import { ComputerUseRememberedApps } from './computerUseRememberedApps'
import { ComputerUseService } from './computerUseService'
import { ComputerUseWindows } from './computerUseWindows'
import { showTrustedDialog } from './trustedDialog'

const ALLOW_FOR_CHAT = 'Allow for this chat'
const ALWAYS_ALLOW = 'Always allow'

export const rememberedApps = new ComputerUseRememberedApps(() =>
  join(app.getPath('userData'), 'computer-use', 'always-allowed.json')
)

async function confirmApp(
  target: ComputerApp,
  signal: AbortSignal,
  starting: boolean
): Promise<boolean> {
  // A wrong click in equipment software can move a machine, so it always asks.
  const physical = target.access.kind === 'physical'
  if (!physical && (await rememberedApps.has(target.path))) return true
  const icon = await app.getFileIcon(target.path, { size: 'large' }).catch(() => null)
  const buttons = physical
    ? ['Don’t allow', ALLOW_FOR_CHAT]
    : ['Don’t allow', ALWAYS_ALLOW, ALLOW_FOR_CHAT]
  const window = appState.mainWindowRef
  const result = await showTrustedDialog(
    window && !window.isDestroyed() ? window : null,
    {
      type: 'warning',
      title: 'Let the agent use this app?',
      message: `Let the agent ${starting ? 'start and use' : 'use'} ${target.title ?? target.name}?`,
      iconDataUrl: icon && !icon.isEmpty() ? icon.toDataURL() : undefined,
      detail: [
        'The agent can read what this app shows, and click and type in it. What it reads goes to the model you selected.',
        target.access.kind === 'powerful' ? target.access.warning : null,
        target.access.kind === 'physical'
          ? 'This looks like software that controls real equipment. A wrong click or value could move a machine. Only allow this if that is safe right now.'
          : 'Some apps only respond to your real mouse and keyboard. For those steps, the agent can wait until you have stepped away, then bring the app forward until its reply ends.',
        'Press Esc at any time to stop it.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      facts: [{ label: 'App', value: target.path, code: true }],
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    { signal }
  )
  const answer = buttons[result.response]
  if (answer === ALWAYS_ALLOW)
    await rememberedApps.add(target.path, target.title).catch(() => undefined)
  return answer === ALWAYS_ALLOW || answer === ALLOW_FOR_CHAT
}

/** Where the driver that ships with SideKick is. */
function bundledDriverPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'computer-driver', 'cua-driver.exe')
    : join(app.getAppPath(), 'build', 'computer-driver', 'cua-driver.exe')
}

let service: ComputerUseService | null = null
const highlight = new ComputerUseHighlight()
const appWindows = new ComputerUseWindows()

/**
 * The one service, with what only Electron can give it: the dialog, Esc, and the notification. Null
 * where the driver isn't there, which only a development checkout should ever see.
 */
export function computerUseService(): ComputerUseService | null {
  const driverPath = bundledDriverPath()
  if (!existsSync(driverPath)) return null
  service ??= new ComputerUseService({
    showActive: (target) => highlight.show(target),
    hideActive: () => highlight.hide(),
    moveCursor: (point) => highlight.moveCursor(point),
    hideCursor: () => highlight.hideCursor(),
    listApps: () => appWindows.apps(),
    showPreview: (image) => highlight.showPreview(image),
    driverPath,
    dataFolder: () => join(app.getPath('userData'), 'computer-use'),
    confirmApp,
    userIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    appWindows,
    startApp: (path) => void appWindows.launch(path),
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
