import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateInfo } from '../../shared/appUpdates'

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.0')
  },
  shell: {
    openExternal: vi.fn(async () => undefined)
  },
  log: {
    initialize: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    transports: { file: { level: 'info' } }
  }
}))

vi.mock('electron', () => ({ app: mocks.app, shell: mocks.shell }))
vi.mock('electron-log/main', () => ({ default: mocks.log }))

import { AppUpdateService, compareStableVersions, parseGitHubRelease } from './appUpdateService'

const originalPlatform = process.platform
const release: AppUpdateInfo = {
  version: '2.0.0',
  releaseName: 'SideKick 2.0.0',
  releaseNotes: 'Community release',
  releaseDate: '2026-07-22T12:00:00.000Z',
  releaseUrl: 'https://github.com/eponce00/sidekick/releases/tag/v2.0.0'
}

describe('AppUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.app.isPackaged = true
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('checks the public release feed and opens only the selected GitHub release', async () => {
    const fetchLatestRelease = vi.fn(async () => release)
    const openExternal = vi.fn(async () => undefined)
    const service = new AppUpdateService({ fetchLatestRelease, openExternal })

    expect(await service.check()).toMatchObject({ status: 'available', update: release })
    expect(await service.openRelease()).toEqual({ opened: true })
    expect(openExternal).toHaveBeenCalledWith(release.releaseUrl)
  })

  it('reports current and older releases as up to date', async () => {
    const service = new AppUpdateService({
      fetchLatestRelease: async () => ({ ...release, version: '1.0.0' }),
      now: () => 42
    })
    expect(await service.check()).toEqual({
      currentVersion: '1.0.0',
      status: 'up-to-date',
      checkedAt: 42
    })
  })

  it('does not initialize network checks for development builds', () => {
    mocks.app.isPackaged = false
    const service = new AppUpdateService()
    expect(service.getState()).toMatchObject({ status: 'disabled', reason: 'development' })
  })

  it('checks releases for packaged Linux builds', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const service = new AppUpdateService()
    expect(service.getState()).toEqual({ currentVersion: '1.0.0', status: 'idle' })
  })
})

describe('GitHub release validation', () => {
  it('accepts only stable releases from the canonical public repository', () => {
    expect(
      parseGitHubRelease({
        tag_name: 'v2.0.0',
        name: 'SideKick 2.0.0',
        body: 'Community release',
        published_at: '2026-07-22T12:00:00.000Z',
        html_url: release.releaseUrl,
        draft: false,
        prerelease: false
      })
    ).toEqual(release)

    expect(() =>
      parseGitHubRelease({
        tag_name: 'v2.0.0',
        html_url: 'https://example.com/releases/tag/v2.0.0'
      })
    ).toThrow(/untrusted/)
    expect(() =>
      parseGitHubRelease({
        tag_name: 'v2.0.0-beta.1',
        html_url: release.releaseUrl
      })
    ).toThrow(/stable/)
  })

  it('compares stable semantic versions without accepting prereleases', () => {
    expect(compareStableVersions('1.0.9', '1.1.0')).toBeLessThan(0)
    expect(compareStableVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareStableVersions('1.0.0', '1.0.0')).toBe(0)
    expect(() => compareStableVersions('1.0.0-beta.1', '1.0.0')).toThrow(/stable/)
  })
})
