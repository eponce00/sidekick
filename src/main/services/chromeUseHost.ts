import { app, nativeImage } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { basename, join } from 'path'
import type { ChromeUseStatus } from '../../shared/computerUse'
import { appState } from '../ipc/state'
import { ChromeUseBridge } from './chromeUseBridge'
import { ChromeUseService } from './chromeUseService'
import {
  chromePath,
  chromeProfilePicture,
  chromeProfiles,
  setUpChromeExtension,
  type ChromeProfile
} from './chromeUseSetup'
import { ComputerUseWindows } from './computerUseWindows'
import { showTrustedDialog, type TrustedDialogOptions } from './trustedDialog'

const ALLOW_FOR_CHAT = 'Allow for this chat'
const DONT_ALLOW = 'Don’t allow'
const INSTALL_MARK = 'installed-profile'
const PROFILE_PICTURE_PX = 96

/**
 * Not in AppData: for a Store-packaged app, or anything started from one, Windows quietly keeps what is
 * written there in the package's private storage. SideKick saw the folder, and Chrome said it didn't exist.
 * A development instance keeps its own, as the secret in it is only good for the instance that wrote it.
 */
function folder(): string {
  return join(
    app.getPath('home'),
    '.sidekick',
    basename(app.getPath('userData')),
    'chrome-extension'
  )
}

function bridgeOf(): ChromeUseBridge {
  bridge ??= new ChromeUseBridge(
    () => join(app.getAppPath(), 'resources', 'chrome-extension'),
    folder
  )
  return bridge
}

let bridge: ChromeUseBridge | null = null
let service: ChromeUseService | null = null
let settingUp: Promise<boolean> | null = null
const windows = new ComputerUseWindows()

function ask(
  options: TrustedDialogOptions,
  signal: AbortSignal
): ReturnType<typeof showTrustedDialog> {
  const window = appState.mainWindowRef
  return showTrustedDialog(window && !window.isDestroyed() ? window : null, options, { signal })
}

async function chromeIcon(): Promise<string | undefined> {
  const chrome = await chromePath()
  if (!chrome) return undefined
  const icon = await app.getFileIcon(chrome, { size: 'large' }).catch(() => null)
  return icon && !icon.isEmpty() ? icon.toDataURL() : undefined
}

function profilePicture(profile: ChromeProfile): string | undefined {
  const path = chromeProfilePicture(profile)
  const picture = path ? nativeImage.createFromPath(path) : null
  return picture && !picture.isEmpty()
    ? picture.resize({ width: PROFILE_PICTURE_PX, quality: 'best' }).toDataURL()
    : undefined
}

async function confirm(
  message: string,
  detail: string,
  facts: TrustedDialogOptions['facts'],
  allow: string,
  signal: AbortSignal
): Promise<boolean> {
  const buttons = [DONT_ALLOW, allow]
  const result = await ask(
    {
      type: 'warning',
      title: message,
      message,
      detail,
      facts,
      iconDataUrl: await chromeIcon(),
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    signal
  )
  return buttons[result.response] === allow
}

function bundledDriver(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'computer-driver', 'cua-driver.exe')
    : join(app.getAppPath(), 'build', 'computer-driver', 'cua-driver.exe')
}

async function installedProfile(): Promise<string | null> {
  return fs.readFile(join(folder(), INSTALL_MARK), 'utf8').catch(() => null)
}

/** The one yes: which profile, what will happen, and what it hands over. Then SideKick does the rest. */
async function runSetup(signal: AbortSignal): Promise<boolean> {
  const chrome = await chromePath()
  if (!chrome) {
    await ask(
      { type: 'info', title: 'Chrome', message: 'Google Chrome isn’t installed.', buttons: ['OK'] },
      signal
    )
    return false
  }
  const profiles = await chromeProfiles().catch(() => [])
  const offered = profiles.filter((profile) => !profile.managed)
  const buttons = ['Not now', ...offered.map((profile) => `Set up in ${profile.name}`)]
  const result = await ask(
    {
      type: 'warning',
      title: 'Let the agent use Chrome?',
      message: 'Let the agent work in your own Chrome?',
      iconDataUrl: await chromeIcon(),
      detail: [
        'It can then ask to work in the profile you pick, with its sign-ins and saved details. You approve each site and any tab you share, and it asks before pressing things like Buy, Send or Delete. It can’t see your other tabs, and what it reads goes to the model you selected.',
        'SideKick will open a Chrome window, turn on Developer mode and load its extension from your computer. This takes about 10 seconds with your real mouse and keyboard, so please don’t touch them until the window closes. Chrome shows a banner while the agent works, and you can remove the extension at chrome://extensions.',
        offered.length
          ? null
          : 'Work profiles can’t be used, because their data and rules belong to your organization.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      choices: profiles.map((profile) => ({
        ...(profile.managed ? {} : { index: offered.indexOf(profile) + 1 }),
        label: profile.name,
        detail: profile.managed
          ? `Work profile, ${profile.domain}: not available`
          : 'Personal profile',
        pictureDataUrl: profilePicture(profile),
        color: profile.color
      })),
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true
    },
    signal
  )
  const choice = offered[result.response - 1]
  if (!choice) return false
  const line = bridgeOf()
  await line.start()
  const failed = await setUpChromeExtension({
    chrome,
    profile: choice.directory,
    extensionFolder: line.folder(),
    driverPath: bundledDriver(),
    dataFolder: join(app.getPath('userData'), 'chrome-extension-setup'),
    windows,
    waitForConnection: (ms, wait) => line.waitForConnection(ms, wait),
    signal
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (failed === null) {
    await fs.writeFile(join(folder(), INSTALL_MARK), choice.directory, 'utf8')
    return true
  }
  await ask(
    {
      type: 'error',
      title: 'Chrome setup didn’t finish',
      message: 'SideKick couldn’t finish setting up Chrome.',
      detail: [
        failed,
        'You can do it yourself: open chrome://extensions, turn on Developer mode, press Load unpacked, and choose the folder below.'
      ].join('\n\n'),
      facts: [{ label: 'Folder', value: line.folder(), code: true }],
      buttons: ['OK']
    },
    signal
  )
  return line.isConnected()
}

function setUp(signal: AbortSignal): Promise<boolean> {
  settingUp ??= runSetup(signal).finally(() => {
    settingUp = null
  })
  return settingUp
}

/** Chrome if it was set up here and is only closed; otherwise the question. */
async function bringUpChrome(signal: AbortSignal): Promise<boolean> {
  await bridgeOf().start()
  const profile = await installedProfile()
  const chrome = await chromePath()
  if (profile && chrome) {
    await windows.launch(chrome, [`--profile-directory="${profile}"`, '--no-startup-window'])
    return true
  }
  return setUp(signal)
}

/** Null where SideKick can't do this: the driver that does the setup ships only with Windows builds. */
export function chromeUseService(): ChromeUseService | null {
  if (!existsSync(bundledDriver())) return null
  service ??= new ChromeUseService({
    bridge: bridgeOf(),
    bringUpChrome,
    confirmSite: (origin, signal) =>
      confirm(
        'Let the agent use this site in Chrome?',
        'It will work with your sign-ins there, and what the page shows goes to the model you selected.',
        [{ label: 'Site', value: origin, code: true }],
        ALLOW_FOR_CHAT,
        signal
      ),
    confirmSharedTab: (tab, signal) =>
      confirm(
        'Share this tab with the agent?',
        'This is the tab you’re on in Chrome. The agent will read it and work in it, with your sign-ins there, and what it shows goes to the model you selected. It won’t see your other tabs.',
        [
          { label: 'Tab', value: tab.title },
          { label: 'Address', value: tab.url, code: true }
        ],
        'Share this tab',
        signal
      ),
    confirmPress: (name, origin, signal) =>
      confirm(
        'Let the agent press this?',
        'This may not be reversible. It could send, buy or delete something in your account.',
        [
          { label: 'Control', value: name },
          { label: 'Site', value: origin, code: true }
        ],
        'Let it press this',
        signal
      )
  })
  return service
}

export async function chromeUseStatus(): Promise<ChromeUseStatus> {
  const line = bridgeOf()
  await line.start()
  const installed = await installedProfile()
  const profiles = installed ? await chromeProfiles().catch(() => []) : []
  const profile = profiles.find((candidate) => candidate.directory === installed)
  return {
    connected: line.isConnected(),
    installed: installed !== null,
    iconDataUrl: await chromeIcon(),
    ...(profile
      ? {
          profile: {
            name: profile.name,
            pictureDataUrl: profilePicture(profile),
            color: profile.color
          }
        }
      : {})
  }
}

export function setUpChromeUse(): Promise<boolean> {
  return setUp(new AbortController().signal)
}
