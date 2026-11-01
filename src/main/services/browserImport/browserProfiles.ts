import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  IMPORT_BROWSER_NAMES,
  type BrowserImportSource,
  type ImportBrowser
} from '../../../shared/browserLibrary'
import { parseChromiumLocalState } from './chromiumProfile'
import { parseFirefoxProfilesIni } from './firefoxProfile'
import { readProfileFile } from './profileFiles'

/** Where this computer keeps per-user application data. */
export interface ImportEnvironment {
  platform: NodeJS.Platform
  home: string
  /** Windows `%LOCALAPPDATA%`. */
  localAppData?: string
  /** Windows `%APPDATA%`. */
  appData?: string
  /** Linux `$XDG_CONFIG_HOME`. */
  configHome?: string
}

export function currentImportEnvironment(): ImportEnvironment {
  const home = homedir()
  return {
    platform: process.platform,
    home,
    localAppData: process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
    appData: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    configHome: process.env.XDG_CONFIG_HOME || join(home, '.config')
  }
}

export type ProfileKind = 'chromium' | 'firefox' | 'safari'

/** A profile found on this computer. Only the main process holds its folder. */
export interface FoundProfile {
  browser: ImportBrowser
  kind: ProfileKind
  id: string
  name: string
  directory: string
}

/** Each browser's user data folder, per the browsers' own documentation. */
function chromiumRoots(env: ImportEnvironment): Array<[ImportBrowser, string]> {
  if (env.platform === 'win32') {
    const local = env.localAppData ?? join(env.home, 'AppData', 'Local')
    return [
      ['chrome', join(local, 'Google', 'Chrome', 'User Data')],
      ['edge', join(local, 'Microsoft', 'Edge', 'User Data')],
      ['brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      ['chromium', join(local, 'Chromium', 'User Data')]
    ]
  }
  if (env.platform === 'darwin') {
    const support = join(env.home, 'Library', 'Application Support')
    return [
      ['chrome', join(support, 'Google', 'Chrome')],
      ['edge', join(support, 'Microsoft Edge')],
      ['brave', join(support, 'BraveSoftware', 'Brave-Browser')],
      ['chromium', join(support, 'Chromium')],
      ['arc', join(support, 'Arc', 'User Data')]
    ]
  }
  const config = env.configHome ?? join(env.home, '.config')
  return [
    ['chrome', join(config, 'google-chrome')],
    ['edge', join(config, 'microsoft-edge')],
    ['brave', join(config, 'BraveSoftware', 'Brave-Browser')],
    ['chromium', join(config, 'chromium')]
  ]
}

function firefoxRoots(env: ImportEnvironment): string[] {
  if (env.platform === 'win32')
    return [join(env.appData ?? join(env.home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')]
  if (env.platform === 'darwin')
    return [join(env.home, 'Library', 'Application Support', 'Firefox')]
  return [
    join(env.home, '.mozilla', 'firefox'),
    join(env.home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    join(env.home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
  ]
}

/** Chromium names profile folders `Default` and `Profile N`; anything else is not looked in. */
const CHROMIUM_PROFILE_FOLDER = /^(Default|Profile \d{1,4})$/

async function isDirectory(path: string): Promise<boolean> {
  return fs
    .lstat(path)
    .then((stat) => stat.isDirectory())
    .catch(() => false)
}

async function hasAny(directory: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (
      await fs
        .lstat(join(directory, name))
        .then((stat) => stat.isFile())
        .catch(() => false)
    )
      return true
  }
  return false
}

async function chromiumProfiles(browser: ImportBrowser, root: string): Promise<FoundProfile[]> {
  if (!(await isDirectory(root))) return []
  let names = new Map<string, string>()
  try {
    const text = await readProfileFile(join(root, 'Local State'), 16 * 1024 * 1024)
    if (text) names = parseChromiumLocalState(text.toString('utf8'))
  } catch {
    // Without Local State, profiles are still found by their folders, named by folder.
  }
  const folders = await fs.readdir(root).catch(() => [] as string[])
  const profiles: FoundProfile[] = []
  for (const folder of folders
    .filter((name) => CHROMIUM_PROFILE_FOLDER.test(name))
    .sort(profileOrder)) {
    const directory = join(root, folder)
    if (!(await isDirectory(directory)) || !(await hasAny(directory, ['Bookmarks', 'History'])))
      continue
    profiles.push({
      browser,
      kind: 'chromium',
      id: folder,
      name: (names.get(folder) ?? folder).slice(0, 80),
      directory
    })
  }
  return profiles
}

/** `Default` first, then `Profile 1`, `Profile 2`, … in number order. */
function profileOrder(a: string, b: string): number {
  const number = (name: string): number => (name === 'Default' ? -1 : Number(name.slice(8)))
  return number(a) - number(b)
}

async function firefoxProfiles(root: string): Promise<FoundProfile[]> {
  let text: Buffer | undefined
  try {
    text = await readProfileFile(join(root, 'profiles.ini'), 1024 * 1024)
  } catch {
    return []
  }
  if (!text) return []
  const profiles: FoundProfile[] = []
  for (const entry of parseFirefoxProfilesIni(text.toString('utf8'), root)) {
    if (!(await isDirectory(entry.path)) || !(await hasAny(entry.path, ['places.sqlite']))) continue
    profiles.push({
      browser: 'firefox',
      kind: 'firefox',
      id: entry.id,
      name: entry.name.slice(0, 80),
      directory: entry.path
    })
  }
  return profiles
}

/**
 * Safari's folder is listed whenever it exists. macOS may refuse to show what is inside it until
 * SideKick has Full Disk Access, which the preview then explains.
 */
async function safariProfiles(env: ImportEnvironment): Promise<FoundProfile[]> {
  if (env.platform !== 'darwin') return []
  const directory = join(env.home, 'Library', 'Safari')
  const exists = await fs
    .stat(directory)
    .then((stat) => stat.isDirectory())
    .catch((error: { code?: string }) => error?.code === 'EPERM' || error?.code === 'EACCES')
  return exists
    ? [{ browser: 'safari', kind: 'safari', id: 'default', name: 'Safari', directory }]
    : []
}

export async function findProfiles(env: ImportEnvironment): Promise<FoundProfile[]> {
  const found: FoundProfile[] = []
  for (const [browser, root] of chromiumRoots(env))
    found.push(...(await chromiumProfiles(browser, root)))
  // Snap and Flatpak copies of Firefox keep their own profiles.ini, so ids carry the copy's number.
  for (const [index, root] of firefoxRoots(env).entries()) {
    for (const profile of await firefoxProfiles(root))
      found.push({ ...profile, id: `${index}:${profile.id}` })
  }
  found.push(...(await safariProfiles(env)))
  return found
}

/** What the renderer is shown: browsers and their profile names, never their folders. */
export function importSources(profiles: FoundProfile[]): BrowserImportSource[] {
  const sources = new Map<ImportBrowser, BrowserImportSource>()
  for (const profile of profiles) {
    const source = sources.get(profile.browser) ?? {
      browser: profile.browser,
      name: IMPORT_BROWSER_NAMES[profile.browser],
      profiles: []
    }
    source.profiles.push({ id: profile.id, name: profile.name })
    sources.set(profile.browser, source)
  }
  return [...sources.values()]
}
