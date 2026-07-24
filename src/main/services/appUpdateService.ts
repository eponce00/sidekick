import { app, shell } from 'electron'
import log from 'electron-log/main'
import type {
  AppUpdateDisabledReason,
  AppUpdateInfo,
  AppUpdateState
} from '../../shared/appUpdates'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'

const INITIAL_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 30_000
const RELEASES_URL = `https://github.com/${PRODUCT_IDENTITY.repositoryOwner}/${PRODUCT_IDENTITY.repositoryName}/releases`
const LATEST_RELEASE_API = `https://api.github.com/repos/${PRODUCT_IDENTITY.repositoryOwner}/${PRODUCT_IDENTITY.repositoryName}/releases/latest`

interface GitHubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
}

interface AppUpdateServiceOptions {
  disabledReason?: AppUpdateDisabledReason
  fetchLatestRelease?: () => Promise<AppUpdateInfo | null>
  openExternal?: (url: string) => Promise<void>
  now?: () => number
}

function stableVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareStableVersions(left: string, right: string): number {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) throw new Error('Release versions must use stable semantic versioning')
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function trustedReleaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const expectedPrefix = `/${PRODUCT_IDENTITY.repositoryOwner}/${PRODUCT_IDENTITY.repositoryName}/releases/`
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(expectedPrefix)
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export function parseGitHubRelease(value: unknown): AppUpdateInfo {
  if (!value || typeof value !== 'object') throw new Error('GitHub returned an invalid release')
  const release = value as GitHubRelease
  if (release.draft === true || release.prerelease === true) {
    throw new Error('GitHub returned a non-stable release')
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = tag.startsWith('v') ? tag.slice(1) : ''
  if (!stableVersion(version)) throw new Error('GitHub returned an invalid stable release tag')
  const releaseUrl = trustedReleaseUrl(release.html_url)
  if (!releaseUrl) throw new Error('GitHub returned an untrusted release URL')

  return {
    version,
    releaseName:
      typeof release.name === 'string' && release.name.trim() ? release.name.trim() : null,
    releaseNotes:
      typeof release.body === 'string' && release.body.trim() ? release.body.trim() : null,
    releaseDate:
      typeof release.published_at === 'string' && release.published_at
        ? release.published_at
        : null,
    releaseUrl
  }
}

async function fetchLatestGitHubRelease(): Promise<AppUpdateInfo | null> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${PRODUCT_IDENTITY.productName}/${app.getVersion()}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}`)
  return parseGitHubRelease(await response.json())
}

export function updateDisabledReason(): AppUpdateDisabledReason | undefined {
  if (!app.isPackaged) return 'development'
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return 'unsupported-platform'
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AppUpdateService {
  private state: AppUpdateState
  private readonly listeners = new Set<(next: AppUpdateState) => void>()
  private readonly fetchLatestRelease: () => Promise<AppUpdateInfo | null>
  private readonly openExternal: (url: string) => Promise<void>
  private readonly now: () => number
  private checkPromise: Promise<AppUpdateState> | null = null
  private initialCheckTimer: ReturnType<typeof setTimeout> | null = null
  private checkInterval: ReturnType<typeof setInterval> | null = null

  constructor(options: AppUpdateServiceOptions = {}) {
    const disabledReason = options.disabledReason ?? updateDisabledReason()
    this.state = disabledReason
      ? { currentVersion: app.getVersion(), status: 'disabled', reason: disabledReason }
      : { currentVersion: app.getVersion(), status: 'idle' }
    this.fetchLatestRelease = options.fetchLatestRelease ?? fetchLatestGitHubRelease
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.now = options.now ?? Date.now
    log.initialize()
    log.transports.file.level = 'info'
  }

  getState(): AppUpdateState {
    return this.state
  }

  subscribe(listener: (next: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private transition(next: AppUpdateState): AppUpdateState {
    log.info('Release checker state changed', { from: this.state.status, to: next.status })
    this.state = next
    for (const listener of this.listeners) listener(next)
    return next
  }

  check(userInitiated = true): Promise<AppUpdateState> {
    if (this.state.status === 'disabled') return Promise.resolve(this.state)
    if (this.checkPromise) return this.checkPromise

    const base = { currentVersion: app.getVersion() }
    this.checkPromise = (async () => {
      this.transition({ ...base, status: 'checking' })
      const latest = await this.fetchLatestRelease()
      if (!latest || compareStableVersions(base.currentVersion, latest.version) >= 0) {
        return userInitiated
          ? this.transition({ ...base, status: 'up-to-date', checkedAt: this.now() })
          : this.transition({ ...base, status: 'idle' })
      }
      return this.transition({ ...base, status: 'available', update: latest })
    })()
      .catch((error) => {
        log.warn('Release check failed', { message: errorMessage(error), userInitiated })
        return userInitiated
          ? this.transition({ ...base, status: 'error', message: errorMessage(error) })
          : this.transition({ ...base, status: 'idle' })
      })
      .finally(() => {
        this.checkPromise = null
      })
    return this.checkPromise
  }

  async openRelease(): Promise<{ opened: boolean }> {
    const url = this.state.status === 'available' ? this.state.update.releaseUrl : RELEASES_URL
    await this.openExternal(url)
    return { opened: true }
  }

  start(): void {
    if (this.state.status === 'disabled' || this.initialCheckTimer || this.checkInterval) return
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null
      void this.check(false)
    }, INITIAL_CHECK_DELAY_MS)
    this.initialCheckTimer.unref()
    this.checkInterval = setInterval(() => void this.check(false), CHECK_INTERVAL_MS)
    this.checkInterval.unref()
  }

  stop(): void {
    if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer)
    if (this.checkInterval) clearInterval(this.checkInterval)
    this.initialCheckTimer = null
    this.checkInterval = null
  }
}
