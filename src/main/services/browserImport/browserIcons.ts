import { app, nativeImage, type NativeImage } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { IMPORT_BROWSERS, type ImportBrowser } from '../../../shared/browserLibrary'

/** Each browser's application bundle on macOS, by its own name. */
const MAC_APPS: Record<ImportBrowser, string> = {
  chrome: 'Google Chrome.app',
  edge: 'Microsoft Edge.app',
  brave: 'Brave Browser.app',
  chromium: 'Chromium.app',
  arc: 'Arc.app',
  firefox: 'Firefox.app',
  safari: 'Safari.app'
}

/** Each browser's executable on Windows, below Program Files or the per-user install folder. */
const WINDOWS_EXECUTABLES: Partial<Record<ImportBrowser, string[]>> = {
  chrome: ['Google\\Chrome\\Application\\chrome.exe'],
  edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
  brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  chromium: ['Chromium\\Application\\chrome.exe'],
  firefox: ['Mozilla Firefox\\firefox.exe']
}

/**
 * Each browser's icon name in the freedesktop icon theme. On Linux `app.getFileIcon` answers with
 * the generic icon for an executable's file type, so the browser's own icon is read from the theme.
 */
const LINUX_ICON_NAMES: Partial<Record<ImportBrowser, string[]>> = {
  chrome: ['google-chrome'],
  edge: ['microsoft-edge'],
  brave: ['brave-browser'],
  chromium: ['chromium', 'chromium-browser', 'org.chromium.Chromium'],
  firefox: ['firefox', 'org.mozilla.firefox']
}

const ICON_PIXELS = 64

async function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) if (await exists(path)) return path
  return undefined
}

async function systemIcon(path: string): Promise<NativeImage | undefined> {
  return app.getFileIcon(path, { size: 'normal' }).catch(() => undefined)
}

async function windowsIcon(browser: ImportBrowser): Promise<NativeImage | undefined> {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  ].filter((root): root is string => Boolean(root))
  const executable = await firstExisting(
    (WINDOWS_EXECUTABLES[browser] ?? []).flatMap((file) => roots.map((root) => join(root, file)))
  )
  return executable ? systemIcon(executable) : undefined
}

async function macIcon(browser: ImportBrowser): Promise<NativeImage | undefined> {
  const bundle = MAC_APPS[browser]
  const found = await firstExisting([
    join('/Applications', bundle),
    join(homedir(), 'Applications', bundle),
    // Safari lives in the system's sealed volume on recent macOS.
    join('/System/Applications', bundle),
    join('/System/Volumes/Preboot/Cryptexes/App/System/Applications', bundle)
  ])
  return found ? systemIcon(found) : undefined
}

async function linuxIcon(browser: ImportBrowser): Promise<NativeImage | undefined> {
  const names = LINUX_ICON_NAMES[browser] ?? []
  const themes = [
    join(homedir(), '.local', 'share', 'icons', 'hicolor'),
    '/usr/share/icons/hicolor',
    '/var/lib/flatpak/exports/share/icons/hicolor'
  ]
  const sizes = ['64x64', '48x48', '128x128', '256x256', '32x32']
  const files = names.flatMap((name) => [
    ...themes.flatMap((theme) => sizes.map((size) => join(theme, size, 'apps', `${name}.png`))),
    join('/usr/share/pixmaps', `${name}.png`)
  ])
  if (browser === 'firefox') files.push('/snap/firefox/current/default256.png')
  const file = await firstExisting(files)
  if (!file) return undefined
  const image = nativeImage.createFromPath(file)
  const { width } = image.getSize()
  return width > ICON_PIXELS ? image.resize({ width: ICON_PIXELS, quality: 'best' }) : image
}

const cache = new Map<ImportBrowser, Promise<string | null>>()

/**
 * The installed browser's own icon as a data URL, or null when it is not found. The renderer names
 * only a browser id; every file looked at is one of the fixed install locations above.
 */
export function browserIcon(browser: unknown): Promise<string | null> {
  if (typeof browser !== 'string' || !(IMPORT_BROWSERS as readonly string[]).includes(browser))
    return Promise.resolve(null)
  const id = browser as ImportBrowser
  let icon = cache.get(id)
  if (!icon) {
    const read =
      process.platform === 'win32'
        ? windowsIcon(id)
        : process.platform === 'darwin'
          ? macIcon(id)
          : linuxIcon(id)
    icon = read
      .then((image) => (image && !image.isEmpty() ? image.toDataURL() : null))
      .catch(() => null)
    cache.set(id, icon)
  }
  return icon
}
