import { join } from 'path'
import type { GitInstallResult } from '../../shared/workspaceHistory'

const WINGET_INSTALL = [
  'install',
  '--id',
  'Git.Git',
  '--exact',
  '--source',
  'winget',
  // For this account, so it needs no administrator.
  '--scope',
  'user',
  '--silent',
  '--disable-interactivity',
  '--accept-package-agreements',
  '--accept-source-agreements'
] as const

const LOOK_WAIT_MS = 15_000
// Usually a minute. A stuck one shouldn't leave the notice saying it's installing for good.
const INSTALL_WAIT_MS = 10 * 60_000

export interface GitInstallParts {
  platform: NodeJS.Platform
  localAppData?: string
  /** Whether Git runs now, which also finds a Git this process's PATH doesn't know about. */
  gitWorks: () => Promise<boolean>
  run: (file: string, args: readonly string[], ms: number) => Promise<void>
  /** The user's yes, in a dialog of the main process's own. */
  confirm: () => Promise<boolean>
  openDownloadPage: () => Promise<void>
}

/** Gets Git onto this computer in the plainest way each platform has. */
export async function installGit(parts: GitInstallParts): Promise<GitInstallResult> {
  if (await parts.gitWorks()) return { outcome: 'ready' }
  if (parts.platform === 'darwin') {
    // Apple's own window asks and does the rest. It fails only if the tools are already there.
    await parts.run('/usr/bin/xcode-select', ['--install'], LOOK_WAIT_MS).catch(() => undefined)
    return { outcome: 'elsewhere' }
  }
  const winget =
    parts.platform === 'win32' && parts.localAppData
      ? join(parts.localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')
      : null
  const canInstall =
    winget !== null &&
    (await parts.run(winget, ['--version'], LOOK_WAIT_MS).then(
      () => true,
      () => false
    ))
  // Older Windows has no winget, and Linux has no one installer to call without a terminal.
  if (!canInstall) {
    await parts.openDownloadPage()
    return { outcome: 'elsewhere' }
  }
  if (!(await parts.confirm())) return { outcome: 'declined' }
  await parts
    .run(winget, WINGET_INSTALL, INSTALL_WAIT_MS)
    .catch((error) => console.warn('[Git] winget did not finish:', (error as Error).message))
  // What counts is whether Git runs, as winget also fails for a Git that's already there.
  return { outcome: (await parts.gitWorks()) ? 'ready' : 'failed' }
}
