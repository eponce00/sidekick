import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandRunner } from './commandRunner'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  createWriteStream: () => ({ write: vi.fn(), end: (done: () => void) => done() })
}))

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true)
  })
  mocks.spawn.mockReturnValueOnce(child)
  const runner = new CommandRunner()
  const pending = runner.run({
    id: 'owned-fixture',
    command: 'fixture',
    cwd: '.',
    timeoutMs: 10_000,
    outputPath: 'unused-mocked.log'
  })
  return { child, runner, pending }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.spawn.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe.runIf(process.platform === 'win32')('Windows command termination failures', () => {
  it('does not report success when a cancelled child exits with zero', async () => {
    const { child, runner, pending } = fixture()
    mocks.spawn.mockReturnValueOnce(new EventEmitter())
    expect(runner.cancel('owned-fixture')).toBe(true)
    child.emit('close', 0, null)
    expect(await pending).toMatchObject({ success: false, cancelled: true, exitCode: 0 })
  })

  it('falls back when taskkill spawn throws without losing cancellation tracking', async () => {
    const { child, runner, pending } = fixture()
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('synthetic spawn failure')
    })
    expect(() => runner.cancel('owned-fixture')).not.toThrow()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null, 'SIGTERM')
    expect(await pending).toMatchObject({ success: false, cancelled: true })
  })

  it('contains a throwing fallback without pretending that the child closed', async () => {
    const { child, runner, pending } = fixture()
    const killer = new EventEmitter()
    mocks.spawn.mockReturnValueOnce(killer)
    child.kill.mockImplementation(() => {
      throw new Error('synthetic kill failure')
    })
    runner.cancel('owned-fixture')
    expect(() => killer.emit('error', new Error('synthetic taskkill failure'))).not.toThrow()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGTERM')
    expect(await pending).toMatchObject({ success: false, cancelled: true })
  })

  it('keeps timeout escalation scheduled when both termination attempts throw', async () => {
    const { child, pending } = fixture()
    mocks.spawn.mockImplementation(() => {
      throw new Error('synthetic taskkill launch failure')
    })
    child.kill.mockImplementation(() => {
      throw new Error('synthetic fallback failure')
    })
    await vi.advanceTimersByTimeAsync(13_000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    child.emit('close', 0, null)
    expect(await pending).toMatchObject({
      success: false,
      exitCode: 0,
      error: 'Command timed out after 10 seconds'
    })
  })
})
