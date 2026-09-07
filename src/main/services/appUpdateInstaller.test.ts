import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  root: '',
  choice: 1,
  quit: vi.fn(),
  show: vi.fn(),
  spawn: vi.fn(),
  relaunch: vi.fn(),
  error: vi.fn(),
  failSpawn: false
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      mocks.spawn(...args)
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      queueMicrotask(() =>
        mocks.failSpawn ? child.emit('error', new Error('blocked')) : child.emit('spawn')
      )
      return child
    }
  }
})
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => mocks.root, quit: mocks.quit, relaunch: mocks.relaunch },
  dialog: { showMessageBox: async () => ({ response: mocks.choice }), showErrorBox: mocks.error },
  shell: { showItemInFolder: mocks.show }
}))
import {
  checksumForAsset,
  downloadAppUpdate,
  installAppUpdate,
  MAC_UPDATE_SCRIPT,
  updateAssetName,
  verifyUpdateFile
} from './appUpdateInstaller'

const bytes = Buffer.from('test installer bytes, never executable')
const digest = createHash('sha256').update(bytes).digest('hex')
const originalPlatform = process.platform

describe('verified community updates', () => {
  beforeEach(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), 'sidekick-updater-test-'))
    mocks.choice = 1
    mocks.failSpawn = false
    vi.clearAllMocks()
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    await rm(mocks.root, { recursive: true, force: true })
  })
  it('selects exact supported platform assets, rejecting unsupported architectures and versions', () => {
    expect(updateAssetName('0.8.0', 'darwin', 'arm64')).toBe('SideKick-0.8.0-macos-arm64.zip')
    expect(updateAssetName('0.8.0', 'win32', 'x64')).toBe('SideKick-0.8.0-windows-x64-setup.exe')
    expect(() => updateAssetName('../x', 'win32', 'x64')).toThrow()
    expect(() => updateAssetName('0.8.0', 'darwin', 'x64')).toThrow(/architecture/)
  })
  it('requires one exact checksum record', () => {
    expect(checksumForAsset(`${digest}  app.zip\n`, 'app.zip')).toBe(digest)
    expect(() => checksumForAsset(`${digest}  app.zip\n${digest}  app.zip`, 'app.zip')).toThrow(
      /ambiguous/
    )
    expect(() => checksumForAsset(`${digest}  other.zip`, 'app.zip')).toThrow(/missing/)
  })
  it('downloads, verifies and reuses only revalidated cached bytes', async () => {
    const asset = updateAssetName('0.8.0')
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('SHA256SUMS.txt')
        ? new Response(`${digest}  ${asset}\n`)
        : new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    )
    vi.stubGlobal('fetch', fetcher)
    const progress = vi.fn()
    const result = await downloadAppUpdate('0.8.0', progress, new AbortController().signal)
    expect(await readFile(result.path)).toEqual(bytes)
    expect(progress).toHaveBeenLastCalledWith(100)
    expect((await downloadAppUpdate('0.8.0', progress, new AbortController().signal)).path).toBe(
      result.path
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
    await writeFile(result.path, 'tampered')
    await expect(verifyUpdateFile(result)).rejects.toThrow(/checksum mismatch/)
    const fresh = await downloadAppUpdate('0.8.0', progress, new AbortController().signal)
    expect(fresh.path).not.toBe(result.path)
    await verifyUpdateFile(fresh)
  })
  it('rejects redirect escape before fetching an untrusted host', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/update' } })
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(downloadAppUpdate('0.8.0', vi.fn(), new AbortController().signal)).rejects.toThrow(
      /Untrusted/
    )
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not retain corrupt downloads', async () => {
    const asset = updateAssetName('0.8.0')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('SHA256SUMS.txt')
          ? new Response(`${digest}  ${asset}`)
          : new Response('wrong bytes')
      )
    )
    await expect(downloadAppUpdate('0.8.0', vi.fn(), new AbortController().signal)).rejects.toThrow(
      /checksum/
    )
    expect(await readdir(join(mocks.root, 'updates'))).toEqual([])
  })
  it('never shuts down on cancel or a tampered installer', async () => {
    const path = join(mocks.root, 'installer')
    await writeFile(path, bytes)
    const update = { path, sha256: digest, version: '0.8.0', mode: 'restart' as const }
    const shutdown = vi.fn()
    expect(await installAppUpdate(update, shutdown)).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    await writeFile(path, 'corrupt')
    await expect(installAppUpdate(update, shutdown)).rejects.toThrow(/checksum/)
    expect(mocks.quit).not.toHaveBeenCalled()
  })
  it('the Mac helper waits for shutdown, retains a backup, and never bypasses OS security', () => {
    expect(MAC_UPDATE_SCRIPT.indexOf('kill -0')).toBeLessThan(MAC_UPDATE_SCRIPT.indexOf('/bin/mv'))
    expect(MAC_UPDATE_SCRIPT).toContain('/bin/mv "$backup" "$target"')
    expect(MAC_UPDATE_SCRIPT).not.toMatch(/sudo|xattr|spctl|rm /)
  })
  it.skipIf(originalPlatform === 'win32')('parses the actual Mac helper with POSIX sh', () => {
    execFileSync('/bin/sh', ['-n'], { input: MAC_UPDATE_SCRIPT })
  })
  it('hands a verified Windows installer to NSIS only after graceful shutdown, without reboot flags', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.choice = 0
    const path = join(mocks.root, 'installer.exe')
    await writeFile(path, bytes)
    const shutdown = vi.fn(async () => {
      expect(mocks.spawn).not.toHaveBeenCalled()
    })
    expect(
      await installAppUpdate({ path, sha256: digest, version: '0.8.0', mode: 'restart' }, shutdown)
    ).toBe(true)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledWith(
      path,
      ['--updated', '--force-run'],
      expect.objectContaining({ shell: false, windowsHide: true })
    )
    expect(mocks.quit).toHaveBeenCalledOnce()
  })
  it('relaunches the existing app if OS launch fails after database shutdown', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.choice = 0
    mocks.failSpawn = true
    const path = join(mocks.root, 'installer.exe')
    await writeFile(path, bytes)
    expect(
      await installAppUpdate(
        { path, sha256: digest, version: '0.8.0', mode: 'restart' },
        async () => undefined
      )
    ).toBe(false)
    expect(mocks.error).toHaveBeenCalledOnce()
    expect(mocks.relaunch).toHaveBeenCalledOnce()
    expect(mocks.quit).toHaveBeenCalledOnce()
  })
})
