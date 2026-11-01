import { promises as fs } from 'fs'
import { join } from 'path'
import type { ComputerDriver } from './computerUseDriver'
import { computerRowPoints, startComputerDriver } from './computerUseDriver'
import type { ComputerHighlightTarget } from './computerUseHighlight'
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
  /** The organization's domain, on a managed profile. */
  domain?: string
  /** Chrome's copy of the account's picture, inside the profile's folder. */
  pictureFile?: string
  /** The colour Chrome gives the profile, as #rrggbb. */
  color?: string
}

/** The profiles Chrome lists, from its own Local State file. Only for the user's dialog, not the model. */
export function parseChromeProfiles(localState: string): ChromeProfile[] {
  const cache = (
    JSON.parse(localState) as {
      profile?: {
        info_cache?: Record<
          string,
          {
            name?: string
            hosted_domain?: string
            gaia_picture_file_name?: string
            default_avatar_fill_color?: number
          }
        >
      }
    }
  ).profile?.info_cache
  return Object.entries(cache ?? {}).map(([directory, info]) => {
    const managed = Boolean(info.hosted_domain && info.hosted_domain !== 'NO_HOSTED_DOMAIN')
    const fill = info.default_avatar_fill_color
    return {
      directory,
      name: info.name || directory,
      managed,
      ...(managed ? { domain: info.hosted_domain } : {}),
      // Only a file name: it is read from inside this profile's folder and nowhere else.
      ...(info.gaia_picture_file_name && /^[^\\/:]+$/.test(info.gaia_picture_file_name)
        ? { pictureFile: info.gaia_picture_file_name }
        : {}),
      // Stored as a signed number holding alpha, red, green and blue.
      ...(typeof fill === 'number'
        ? { color: `#${((fill >>> 0) & 0xffffff).toString(16).padStart(6, '0')}` }
        : {})
    }
  })
}

function chromeUserData(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')
}

/** Where a profile's picture is, if Chrome has one for it. */
export function chromeProfilePicture(profile: ChromeProfile): string | null {
  return profile.pictureFile ? join(chromeUserData(), profile.directory, profile.pictureFile) : null
}

export async function chromeProfiles(): Promise<ChromeProfile[]> {
  const file = join(chromeUserData(), 'Local State')
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
  windows: Pick<
    ComputerUseWindows,
    | 'apps'
    | 'windowsOf'
    | 'ownedBy'
    | 'pathOf'
    | 'closeWindow'
    | 'front'
    | 'pointer'
    | 'pointerTo'
    | 'launch'
    | 'restore'
    | 'visible'
  >
  /** The same marks as when the agent is driving: this is SideKick at the controls too. */
  overlay: {
    show: (target: ComputerHighlightTarget) => void
    hide: () => void
    moveCursor: (point: { x: number; y: number }) => Promise<void> | void
  }
  waitForConnection: (ms: number, signal: AbortSignal) => Promise<boolean>
  signal: AbortSignal
}

interface FoundRow {
  token: string
  /** Where it is on screen, for the pointer to get there first. */
  point?: { x: number; y: number }
}

/** The first row whose line has this text, or null, with what is needed to press it. */
function rowWith(state: { text: string; structured?: unknown }, wanted: RegExp): FoundRow | null {
  const snapshot = /snapshot_id=(\S+)/.exec(state.text)?.[1]
  if (!snapshot) return null
  const points = computerRowPoints(state.structured)
  for (const line of state.text.split('\n')) {
    const found = /^\W*\[(\d+)\] (.*)$/.exec(line)
    if (found && wanted.test(found[2])) {
      return { token: `${snapshot}:${found[1]}`, point: points.get(Number(found[1])) }
    }
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
  let picker: number | null = null
  let done = false
  parts.overlay.show({
    appName: 'Chrome',
    visible: () => windows.visible(mine.id),
    bounds: async () =>
      (await windows.windowsOf(mine.pid)).find((window) => window.id === mine.id)?.bounds ?? null
  })
  const pointAt = async (row: FoundRow): Promise<void> => {
    if (row.point) await parts.overlay.moveCursor(row.point)
  }
  try {
    driver = await startComputerDriver(parts.driverPath, parts.dataFolder, [chrome])
    const target = { pid: mine.pid, window_id: mine.id }
    const real = { delivery_mode: 'foreground' }
    const call = driver.call.bind(driver)
    await call('bring_to_front', target, signal)
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
    // These keys go to whatever is in front, so it has to be this window.
    if ((await windows.front()) !== mine.id) {
      await windows.restore(mine.id)
      await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
      if ((await windows.front()) !== mine.id) return "Chrome's window didn't come to the front."
    }
    // About where the address bar is, as that's what the keys below go to.
    const frame = (await windows.windowsOf(mine.pid)).find(
      (window) => window.id === mine.id
    )?.bounds
    if (frame) {
      await parts.overlay.moveCursor({
        x: Math.round(frame.x + frame.width * 0.3),
        y: Math.round(frame.y + frame.height * 0.07)
      })
    }
    await call('press_key', { ...target, key: 'l', modifiers: ['ctrl'], ...real }, signal)
    await call('type_text', { ...target, text: 'chrome://extensions', ...real }, signal)
    await call('press_key', { ...target, key: 'return', modifiers: [], ...real }, signal)
    const search = (window: number, query: string, pid = mine.pid): ReturnType<typeof call> =>
      call(
        'get_window_state',
        {
          pid,
          window_id: window,
          tree_format: 'both',
          include_screenshot: true,
          max_elements: 5000,
          timeout_ms: 3000,
          query
        },
        signal
      )
    const press = (window: number, token: string, pid = mine.pid): Promise<unknown> =>
      call('click', { pid, window_id: window, element_token: token }, signal)
    const loadUnpacked = (): Promise<FoundRow | null> =>
      search(mine.id, 'Load unpacked').then((state) => rowWith(state, /Load unpacked/i))
    if (!(await loadUnpacked())) {
      const toggle = await until(
        () => search(mine.id, 'Developer mode').then((state) => rowWith(state, /Developer mode/i)),
        signal
      )
      if (!toggle) return "Chrome's extensions page didn't show its Developer mode switch."
      await pointAt(toggle)
      await press(mine.id, toggle.token)
    }
    const button = await until(loadUnpacked, signal)
    if (!button) return "Chrome didn't show its Load unpacked button."
    await pointAt(button)
    // Not waited for: pressing a button can last for as long as the dialog it opens.
    void press(mine.id, button.token).catch(() => undefined)
    const opened = await until(async () => (await windows.ownedBy(mine.id))[0] ?? null, signal)
    if (!opened) return "Chrome didn't open its folder picker."
    picker = opened.id
    const pickerPid = opened.owner ?? mine.pid
    // It's another process, and the driver is only allowed Chrome's own.
    if ((await windows.pathOf(pickerPid)).toLowerCase() !== chrome.toLowerCase()) {
      return "The folder picker didn't belong to Chrome."
    }
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
    const field = await until(
      () =>
        search(opened.id, 'Folder', pickerPid).then((state) =>
          rowWith(state, /Edit.*Folder|Folder.*Edit/i)
        ),
      signal
    )
    if (!field) return "Couldn't find the folder box in Chrome's folder picker."
    await pointAt(field)
    await call(
      'set_value',
      {
        pid: pickerPid,
        window_id: opened.id,
        element_token: field.token,
        value: parts.extensionFolder
      },
      signal
    )
    const select = await until(
      () =>
        search(opened.id, 'Select Folder', pickerPid).then((state) =>
          rowWith(state, /Select Folder/i)
        ),
      signal
    )
    // Enter does the same in the box, should the button go by another name.
    if (select) {
      await pointAt(select)
      void press(opened.id, select.token, pickerPid).catch(() => undefined)
    } else {
      await call(
        'press_key',
        { pid: pickerPid, window_id: opened.id, key: 'return', modifiers: [], ...real },
        signal
      )
    }
    if (!(await parts.waitForConnection(CONNECT_WAIT_MS, signal))) {
      return "The extension didn't connect after it was loaded."
    }
    picker = null
    done = true
    return null
  } finally {
    // Whether it worked or not, what this opened doesn't stay on the user's screen.
    if (picker && !done) await windows.closeWindow(picker).catch(() => false)
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SETTLE_MS))
    await windows.closeWindow(mine.id).catch(() => false)
    parts.overlay.hide()
    await driver?.close().catch(() => undefined)
    if (home) await windows.pointerTo(home).catch(() => false)
    if (handBack) await windows.restore(handBack).catch(() => false)
  }
}
