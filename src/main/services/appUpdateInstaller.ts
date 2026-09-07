import { app, dialog, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'

const execute = promisify(execFile)
const REPOSITORY = `${PRODUCT_IDENTITY.repositoryOwner}/${PRODUCT_IDENTITY.repositoryName}`
const MAX_INSTALLER_BYTES = 1_500_000_000
export interface PreparedAppUpdate {
  path: string
  sha256: string
  version: string
  mode: 'restart' | 'manual'
}

export function updateAssetName(
  version: string,
  platform = process.platform,
  arch = process.arch
): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid update version')
  if (platform === 'win32' && arch === 'x64') return `SideKick-${version}-windows-x64-setup.exe`
  if (platform === 'darwin' && arch === 'arm64') return `SideKick-${version}-macos-arm64.zip`
  if (platform === 'linux' && arch === 'x64') return `SideKick-${version}-linux-x64.AppImage`
  throw new Error('No update package for this platform/architecture. Use View release.')
}

export function checksumForAsset(manifest: string, name: string): string {
  const matches = manifest
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64}) [ *](\S+)$/.exec(line))
    .filter((match) => match?.[2] === name)
  if (matches.length !== 1) throw new Error('Release checksum missing or ambiguous')
  return matches[0]![1].toLowerCase()
}

function trustedDownloadUrl(value: string): boolean {
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    ((url.hostname === 'github.com' &&
      url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) ||
      url.hostname === 'release-assets.githubusercontent.com')
  )
}

async function downloadResponse(url: string, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!trustedDownloadUrl(url)) throw new Error('Untrusted update download location')
    const response = await fetch(url, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Update redirect has no location')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok || !response.body)
      throw new Error(`Update download failed (HTTP ${response.status})`)
    return response
  }
  throw new Error('Too many update redirects')
}

export async function verifyUpdateFile(update: PreparedAppUpdate): Promise<void> {
  const stat = await lstat(update.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INSTALLER_BYTES)
    throw new Error('Invalid staged update')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(update.path)) hash.update(chunk)
  if (hash.digest('hex') !== update.sha256)
    throw new Error('Update checksum mismatch; nothing was installed')
}

export async function downloadAppUpdate(
  version: string,
  progress: (percent: number) => void,
  signal: AbortSignal
): Promise<PreparedAppUpdate> {
  const name = updateAssetName(version)
  const base = `https://github.com/${REPOSITORY}/releases/download/v${version}/`
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
  const checksums = await downloadResponse(`${base}SHA256SUMS.txt`, timeout)
  let manifest = ''
  for await (const chunk of checksums.body!) {
    manifest += Buffer.from(chunk).toString('utf8')
    if (manifest.length > 64_000) throw new Error('Oversized checksum manifest')
  }
  const sha256 = checksumForAsset(manifest, name)
  const root = join(app.getPath('userData'), 'updates')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink())
    throw new Error('Update directory must not be a symlink')
  // Reuse only independently revalidated packages; never trust a "downloaded" marker.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('pending-')) continue
    const candidate: PreparedAppUpdate = {
      path: join(root, entry.name, name),
      sha256,
      version,
      mode: process.platform === 'linux' ? 'manual' : 'restart'
    }
    try {
      await verifyUpdateFile(candidate)
      progress(100)
      return candidate
    } catch {
      /* Download a fresh copy. */
    }
  }
  const directory = await mkdtemp(join(root, 'pending-'))
  const path = join(directory, name)
  try {
    const response = await downloadResponse(`${base}${name}`, timeout)
    const size = Number(response.headers.get('content-length'))
    if (size > MAX_INSTALLER_BYTES) throw new Error('Oversized update')
    const file = await open(path, 'wx', 0o600)
    let received = 0
    try {
      for await (const chunk of response.body!) {
        timeout.throwIfAborted()
        received += chunk.byteLength
        if (received > MAX_INSTALLER_BYTES) throw new Error('Oversized update')
        await file.writeFile(chunk)
        progress(size > 0 ? Math.min(99, Math.floor((received / size) * 100)) : 0)
      }
      await file.sync()
    } finally {
      await file.close()
    }
    const result: PreparedAppUpdate = {
      path,
      sha256,
      version,
      mode: process.platform === 'linux' ? 'manual' : 'restart'
    }
    await verifyUpdateFile(result)
    progress(100)
    return result
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

// Fixed script, with paths passed as arguments, never interpolated as shell code.
// No sudo, quarantine removal, Gatekeeper bypass, or deletion of the previous app.
export const MAC_UPDATE_SCRIPT = `
set -eu
on_exit() {
  code=$?
  if [ "$code" -ne 0 ]; then
    /usr/bin/osascript -e 'display alert "SideKick update did not complete" message "The previous app was retained. Check the SideKick updates folder for installer.log, or install the latest release manually."'
  fi
}
trap on_exit EXIT
parent="$1"; target="$2"; staged="$3"; backup="$4"
count=0
while kill -0 "$parent" 2>/dev/null; do
  count=$((count + 1))
  [ "$count" -lt 120 ] || exit 1
  sleep 1
done
[ ! -e "$backup" ] || exit 1
/bin/mv "$target" "$backup"
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target"
  exit 1
fi
if ! /usr/bin/open "$target"; then
  /bin/mv "$target" "$staged"
  /bin/mv "$backup" "$target"
  /usr/bin/open "$target"
  exit 1
fi
`

export async function installAppUpdate(
  update: PreparedAppUpdate,
  beforeQuit: () => Promise<void>
): Promise<boolean> {
  if (!app.isPackaged) throw new Error('Development builds cannot install updates')
  await verifyUpdateFile(update)
  if (update.mode === 'manual') {
    await chmod(update.path, 0o700)
    shell.showItemInFolder(update.path)
    return false
  }
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart SideKick and update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update SideKick',
    message: `Install SideKick ${update.version}?`,
    detail:
      'SideKick will save and close its sessions; active agent work will stop. Your computer will NOT restart. This community release is not notarized/Publisher-signed; the operating system may ask for approval.'
  })
  if (choice.response !== 0) return false
  let command: string
  let args: string[]
  if (process.platform === 'win32') {
    command = update.path
    args = ['--updated', '--force-run']
  } else if (process.platform === 'darwin') {
    const target = resolve(process.execPath, '../../..')
    if (
      !target.endsWith('/SideKick.app') ||
      (await realpath(target)) !== target ||
      target.startsWith('/Volumes/') ||
      target.includes('/AppTranslocation/')
    ) {
      throw new Error(
        'Move SideKick to Applications and launch it there before updating. Use View release if needed.'
      )
    }
    await access(dirname(target), constants.W_OK)
    const staging = await mkdtemp(join(dirname(target), '.sidekick-update-'))
    await execute('/usr/bin/ditto', ['-x', '-k', update.path, staging], { timeout: 120_000 })
    const staged = join(staging, 'SideKick.app')
    if ((await realpath(staged)) !== staged) throw new Error('Invalid staged application bundle')
    for (const [key, expected] of [
      ['CFBundleIdentifier', PRODUCT_IDENTITY.appId],
      ['CFBundleShortVersionString', update.version]
    ]) {
      const result = await execute('/usr/libexec/PlistBuddy', [
        '-c',
        `Print :${key}`,
        join(staged, 'Contents/Info.plist')
      ])
      if (result.stdout.trim() !== expected)
        throw new Error('Update bundle identity/version mismatch')
    }
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], {
      timeout: 60_000
    })
    command = '/bin/sh'
    args = [
      '-c',
      MAC_UPDATE_SCRIPT,
      'sidekick-update',
      String(process.pid),
      target,
      staged,
      join(staging, 'SideKick.previous.app')
    ]
  } else {
    throw new Error('Unsupported automatic installation platform')
  }
  // Run the existing application shutdown, including database flush, before any installer starts.
  try {
    await beforeQuit()
    await verifyUpdateFile(update)
    const installLog = await open(join(dirname(update.path), 'installer.log'), 'a', 0o600)
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', installLog.fd, installLog.fd],
      windowsHide: true,
      shell: false
    })
    try {
      await new Promise<void>((resolveSpawn, reject) => {
        child.once('spawn', resolveSpawn)
        child.once('error', reject)
      })
    } finally {
      await installLog.close()
    }
    child.unref()
  } catch {
    // Shutdown may already have closed the database. Never leave that process interactive.
    dialog.showErrorBox(
      'Update could not start',
      'SideKick will restart its current version. Please retry the update or use View release.'
    )
    app.relaunch()
    app.quit()
    return false
  }
  app.quit()
  return true
}
