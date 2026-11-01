import { promises as fs } from 'fs'
import { join } from 'path'
import type { ComputerDriver } from './computerUseDriver'
import { startComputerDriver } from './computerUseDriver'
import type { ComputerUseWindows } from './computerUseWindows'

const STEP_WAIT_MS = 10_000
const POLL_MS = 400
const WINDOW_SETTLE_MS = 700
const CONNECT_WAIT_MS = 20_000

export interface ChromeProfile {
  directory: string
  name: string
  /** Belongs to an organization, whose data and rules aren't only the user's. */
  managed: boolean
}

/** The profiles Chrome lists, from its own Local State file. Only for the user's dialog, not the model. */
export function parseChromeProfiles(localState: string): ChromeProfile[] {
  const cache = (
    JSON.parse(localState) as {
      profile?: { info_cache?: Record<string, { name?: string; hosted_domain?: string }> }
    }
  ).profile?.info_cache
  return Object.entries(cache ?? {}).map(([directory, info]) => ({
    directory,
    name: info.name || directory,
    managed: Boolean(info.hosted_domain && info.hosted_domain !== 'NO_HOSTED_DOMAIN')
  }))
}

export async function chromeProfiles(): Promise<ChromeProfile[]> {
  const file = join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Local State')
  return parseChromeProfiles(await fs.readFile(file, 'utf8')).sort(
    (a, b) => Number(a.managed) - Number(b.managed)
  )
}

/** Chrome's executable: for this user, or for everyone on this computer. */
export async function chromePath(): Promise<string | null> {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)']
  ]
  for (const root of roots) {
    if (!root) continue
    const path = join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (
      await fs
        .access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      return path
    }
  }
  return null
}

interface SetupParts {
  chrome: string
  profile: string
  extensionFolder: string
  driverPath: string
  dataFolder: string
  windows: ComputerUseWindows
  waitForConnection: (ms: number, signal: AbortSignal) => Promise<boolean>
  signal: AbortSignal
}

/** The first row whose line has this text, or null, with what is needed to press it. */
function rowWith(text: string, wanted: RegExp): { token: string } | null {
  const snapshot = /snapshot_id=(\S+)/.exec(text)?.[1]
  if (!snapshot) return null
  for (const line of text.split('\n')) {
    const found = /^\W*\[(\d+)\] (.*)$/.exec(line)
    if (found && wanted.test(found[2])) return { token: `${snapshot}:${found[1]}` }
  }
  return null
}

async function until<T>(
  look: () => Promise<T | null>,
  signal: AbortSignal,
  ms = STEP_WAIT_MS
): Promise<T | null> {
  const deadline = Date.now() + ms
  for (;;) {
    signal.throwIfAborted()
    const found = await look().catch(() => null)
    if (found) return found
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * What the user said yes to, done the way they would: in a window opened for this, Developer mode on and
 * the extension loaded from SideKick's folder. It goes by what Chrome's own controls are called, in
 * English for now, and the connection is the proof it worked. Null when it did, or why it didn't.
 */
export async function setUpChromeExtension(parts: SetupParts): Promise<string | null> {
  const { windows, signal, chrome } = parts
  const pidsOf = async (): Promise<number[]> =>
    (await windows.apps())
      .filter((app) => app.path.toLowerCase() === chrome.toLowerCase())
      .map((app) => app.pid)
  const windowIds = async (): Promise<Array<{ id: number; pid: number }>> => {
    const all: Array<{ id: number; pid: number }> = []
    for (const pid of await pidsOf()) {
      for (const window of await windows.windowsOf(pid)) all.push({ id: window.id, pid })
    }
    return all
  }
  const handBack = await windows.front()
  const home = await windows.pointer()
  const before = new Set((await windowIds()).map((window) => window.id))
  await windows.launch(chrome, [
    `--profile-directory="${parts.profile}"`,
    '--new-window',
    'about:blank'
  ])
  const mine = await until(async () => {
    const all = await windowIds()
    return all.find((window) => !before.has(window.id)) ?? null
  }, signal)
  if (!mine) return 'Chrome did not open a window.'
  let driver: ComputerDriver | null = null
  try {
    driver = await startComputerDriver(parts.driverPath, parts.dataFolder, [chrome])
    const target = { pid: mine.pid, window_id: mine.id }
    const real = { delivery_mode: 'foreground' }
    const call = driver.call.bind(driver)
    await call('bring_to_front', target, signal)
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
    await call('press_key', { ...target, key: 'l', modifiers: ['ctrl'], ...real }, signal)
    await call('type_text', { ...target, text: 'chrome://extensions', ...real }, signal)
    await call('press_key', { ...target, key: 'return', modifiers: [], ...real }, signal)
    const search = async (window: number, query: string): Promise<string> =>
      (
        await call(
          'get_window_state',
          {
            pid: mine.pid,
            window_id: window,
            tree_format: 'both',
            include_screenshot: true,
            max_elements: 5000,
            timeout_ms: 3000,
            query
          },
          signal
        )
      ).text
    const press = (window: number, token: string): Promise<unknown> =>
      call('click', { pid: mine.pid, window_id: window, element_token: token }, signal)
    const loadUnpacked = (): Promise<{ token: string } | null> =>
      search(mine.id, 'Load unpacked').then((text) => rowWith(text, /Load unpacked/i))
    if (!(await loadUnpacked())) {
      const toggle = await until(
        () => search(mine.id, 'Developer mode').then((text) => rowWith(text, /Developer mode/i)),
        signal
      )
      if (!toggle) return "Chrome's extensions page didn't show its Developer mode switch."
      await press(mine.id, toggle.token)
    }
    const button = await until(loadUnpacked, signal)
    if (!button) return "Chrome didn't show its Load unpacked button."
    const open = new Set((await windowIds()).map((window) => window.id))
    await press(mine.id, button.token)
    const picker = await until(async () => {
      const all = await windowIds()
      return all.find((window) => !open.has(window.id)) ?? null
    }, signal)
    if (!picker) return "Chrome didn't open its folder picker."
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
    const field = await until(
      () => search(picker.id, 'Folder').then((text) => rowWith(text, /Edit.*Folder|Folder.*Edit/i)),
      signal
    )
    if (!field) return "Couldn't find the folder box in Chrome's folder picker."
    await call(
      'set_value',
      {
        pid: mine.pid,
        window_id: picker.id,
        element_token: field.token,
        value: parts.extensionFolder
      },
      signal
    )
    const select = await until(
      () => search(picker.id, 'Select Folder').then((text) => rowWith(text, /Select Folder/i)),
      signal
    )
    if (!select) return "Couldn't find the Select Folder button."
    await press(picker.id, select.token)
    if (!(await parts.waitForConnection(CONNECT_WAIT_MS, signal))) {
      return "The extension didn't connect after it was loaded."
    }
    await call('press_key', { ...target, key: 'w', modifiers: ['ctrl'], ...real }, signal)
    return null
  } finally {
    await driver?.close().catch(() => undefined)
    if (home) await windows.pointerTo(home).catch(() => false)
    if (handBack) await windows.restore(handBack).catch(() => false)
  }
}
