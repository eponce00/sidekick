import { expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  root: '',
  show: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  cancelAll: vi.fn(),
  sandbox: vi.fn(),
  cleanup: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: mocks.show }
}))
vi.mock('./state', () => ({ getStore: () => ({ get: () => mocks.settings }) }))
vi.mock('../services/commandRunner', () => ({
  CommandRunner: class {
    run = mocks.run
    cancel = mocks.cancel
    cancelAll = mocks.cancelAll
  }
}))
vi.mock('../services/dockerShellIsolation', () => ({ isolatedShellProcess: mocks.sandbox }))
vi.mock('../services/bundledSkillAssets', () => ({
  getBundledSkillAssetsPath: () => join(mocks.root, 'skills')
}))
let setupCreatedWorktree: typeof import('./worktreeSetup').setupCreatedWorktree
let shutdownWorktreeSetup: typeof import('./worktreeSetup').shutdownWorktreeSetup
let senderEvents: EventEmitter
let destroyed: boolean
let sender: Electron.WebContents

beforeEach(async () => {
  // Shutdown is deliberately sticky in production; each test owns a fresh module.
  vi.resetModules()
  ;({ setupCreatedWorktree, shutdownWorktreeSetup } = await import('./worktreeSetup'))
  destroyed = false
  senderEvents = new EventEmitter()
  sender = Object.assign(senderEvents, {
    isDestroyed: () => destroyed
  }) as unknown as Electron.WebContents
  mocks.root = mkdtempSync(join(tmpdir(), 'sidekick-worktree-ipc-'))
  mocks.settings = {
    projectWorktreeHooks: [{ workspaceRoot: mocks.root, command: 'echo setup', enabled: true }]
  }
  mocks.run.mockReset().mockResolvedValue({ success: true })
  mocks.cancel.mockReset().mockReturnValue(true)
  mocks.cancelAll.mockReset()
  mocks.show.mockReset().mockResolvedValue({ response: 1 })
  mocks.cleanup.mockReset().mockResolvedValue(undefined)
  mocks.sandbox.mockReset().mockResolvedValue({ file: 'docker', args: [], cleanup: mocks.cleanup })
})
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lastOutput(): string {
  const detail = mocks.show.mock.calls.at(-1)?.[0].detail as string
  const path = detail.split('\n').find((line) => line.endsWith('output.log'))!
  return readFileSync(path, 'utf8')
}

it('fails closed on native denial even when settings would permit full access', async () => {
  mocks.show.mockResolvedValueOnce({ response: 0 })
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.run).not.toHaveBeenCalled()
  expect(mocks.show.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 })
  expect(mocks.show.mock.calls[1][0].title).toBe('Worktree setup incomplete')
})

it('uses isolated execution and cleans up rather than silently falling back to host', async () => {
  mocks.settings.shellIsolation = 'docker'
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.sandbox).toHaveBeenCalledTimes(1)
  expect(mocks.run.mock.calls[0][0]).toMatchObject({
    process: { file: 'docker' },
    timeoutMs: 120000
  })
  expect(mocks.cleanup).toHaveBeenCalledTimes(1)
  mocks.run.mockClear()
  mocks.sandbox.mockRejectedValue(new Error('Docker unavailable'))
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.run).not.toHaveBeenCalled()
  const detail = mocks.show.mock.calls.at(-1)?.[0].detail as string
  const output = detail.split('\n').find((line) => line.endsWith('output.log'))!
  expect(readFileSync(output, 'utf8')).toContain('Docker unavailable')
})

it('does nothing for disabled or nonmatching hooks', async () => {
  mocks.settings.projectWorktreeHooks = [
    { workspaceRoot: mocks.root, command: 'never', enabled: false }
  ]
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.show).not.toHaveBeenCalled()
  expect(mocks.run).not.toHaveBeenCalled()
})

it('records silent timeout diagnostics and uncertain-side-effect guidance in private output', async () => {
  mocks.run.mockResolvedValue({
    success: false,
    exitCode: -1,
    cancelled: false,
    error: 'Command timed out after 120 seconds'
  })
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(lastOutput()).toContain('"exitCode":-1')
  expect(lastOutput()).toContain('Command timed out after 120 seconds')
  expect(lastOutput()).toContain('Effects may have occurred')
  expect(mocks.show.mock.calls.at(-1)?.[0].title).toBe('Worktree setup incomplete')
})

it('preserves output and stops later hooks if successful command cleanup cannot be confirmed', async () => {
  mocks.settings.shellIsolation = 'docker'
  mocks.settings.projectWorktreeHooks = [
    { workspaceRoot: mocks.root, command: 'first', enabled: true },
    { workspaceRoot: mocks.root, command: 'never', enabled: true }
  ]
  mocks.run.mockResolvedValue({ success: true, exitCode: 0 })
  mocks.cleanup.mockRejectedValue(new Error('fixture cleanup uncertainty'))
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(lastOutput()).toContain('"exitCode":0')
  expect(lastOutput()).toContain('Cleanup could not be confirmed: fixture cleanup uncertainty')
  expect(lastOutput()).toContain('Inspect Docker and actual files before retrying')
  expect(mocks.show.mock.calls.at(-1)?.[0].title).toBe('Worktree setup incomplete')
  expect(senderEvents.listenerCount('destroyed')).toBe(0)
})

it('cancels the active command when its sender is destroyed and removes its listener', async () => {
  const started = deferred<void>()
  const result = deferred<{ success: boolean; exitCode: number; cancelled: boolean }>()
  mocks.run.mockImplementation(() => {
    started.resolve()
    return result.promise
  })
  const setup = setupCreatedWorktree(sender, mocks.root, mocks.root)
  await started.promise
  destroyed = true
  senderEvents.emit('destroyed')
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(mocks.run.mock.calls[0][0].id)
  result.resolve({ success: false, exitCode: -1, cancelled: true })
  await setup
  expect(senderEvents.listenerCount('destroyed')).toBe(0)
  expect(mocks.run).toHaveBeenCalledTimes(1)
})

it('keeps shutdown pending until running execution and sandbox cleanup settle', async () => {
  mocks.settings.shellIsolation = 'docker'
  const started = deferred<void>()
  const result = deferred<{ success: boolean; exitCode: number; cancelled: boolean }>()
  const cleanupStarted = deferred<void>()
  const cleanup = deferred<void>()
  mocks.run.mockImplementation(() => {
    started.resolve()
    return result.promise
  })
  mocks.cleanup.mockImplementation(() => {
    cleanupStarted.resolve()
    return cleanup.promise
  })
  const setup = setupCreatedWorktree(sender, mocks.root, mocks.root)
  await started.promise
  let stopped = false
  const shutdown = shutdownWorktreeSetup().then(() => {
    stopped = true
  })
  expect(mocks.cancelAll).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(stopped).toBe(false)
  result.resolve({ success: false, exitCode: -1, cancelled: true })
  await cleanupStarted.promise
  expect(stopped).toBe(false)
  cleanup.resolve()
  await Promise.all([shutdown, setup])
  expect(stopped).toBe(true)
  expect(mocks.cleanup).toHaveBeenCalledTimes(1)
  expect(senderEvents.listenerCount('destroyed')).toBe(0)
  mocks.run.mockClear()
  await setupCreatedWorktree(sender, mocks.root, mocks.root)
  expect(mocks.run).not.toHaveBeenCalled()
})
