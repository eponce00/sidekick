import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  executeDirectOfficeHelper,
  type DirectOfficeHelperInput,
  type OfficeHelperReceipt
} from './directOfficeHelper'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs/promises', () => ({
  realpath: mocks.realpath,
  lstat: mocks.lstat,
  readFile: mocks.readFile
}))
const secret = 'NEVER_RECORD_secret-command-output-environment'
const bytes = Buffer.from('synthetic trusted helper')
const digest = createHash('sha256').update(bytes).digest('hex')
const root = resolve('synthetic-assets')
const interpreter = resolve('synthetic-python')
const workspace = resolve('synthetic-workspace')
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
let receipts: Readonly<OfficeHelperReceipt>[]
const input = (): DirectOfficeHelperInput => ({
  helper: 'validate',
  path: secret,
  timeoutMs: 1000,
  backend: 'host'
})
const config = () => ({
  assetsRoot: root,
  interpreter,
  workspaceRoot: workspace,
  windowsSystemRoot: resolve('trusted-windows'),
  expectedDigests: { validate: digest },
  observe: (receipt: Readonly<OfficeHelperReceipt>) => receipts.push(receipt)
})
async function spawned(): Promise<void> {
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
}

it('handles stdout read errors without usable partial output or premature process settlement', async () => {
  const stdout = new EventEmitter()
  Object.assign(child, { stdout })
  const pending = executeDirectOfficeHelper(config(), input())
  await spawned()
  child.emit('spawn')
  stdout.emit('data', Buffer.from('{"valid":true'))
  expect(() => stdout.emit('error', new Error(secret))).not.toThrow()
  stdout.emit(
    'data',
    Buffer.from(
      ',"scope":"opc-ooxml-structural","xsd_validation":false,"parts_checked":5,"errors":[],"warnings":[]}'
    )
  )
  expect(receipts.map((receipt) => receipt.lifecycle)).toEqual(['started'])
  child.emit('close', 0)
  const result = await pending
  expect(result).toMatchObject({
    lifecycle: 'finished',
    outcome: 'exited',
    exitCode: 0,
    report: { status: 'unusable_output', reason: 'stream_error' }
  })
  expect(JSON.stringify(receipts)).not.toContain(secret)
})

beforeEach(() => {
  vi.resetAllMocks()
  receipts = []
  child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  mocks.realpath.mockImplementation(async (path) => path)
  mocks.lstat.mockResolvedValue({ isFile: () => true })
  mocks.readFile.mockResolvedValue(bytes)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('terminates the owned process tree on cancellation', async () => {
  Object.assign(child, { pid: 43210 })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const controller = new AbortController()
  const pending = executeDirectOfficeHelper(config(), { ...input(), signal: controller.signal })
  await spawned()
  controller.abort()
  if (process.platform === 'win32') {
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      join(resolve('trusted-windows'), 'System32', 'taskkill.exe'),
      ['/pid', '43210', '/t', '/f'],
      expect.objectContaining({
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
        env: { SystemRoot: resolve('trusted-windows') }
      })
    )
  } else {
    expect(kill).toHaveBeenCalledWith(-43210, 'SIGTERM')
  }
  child.emit('close', null)
  expect(await pending).toMatchObject({ outcome: 'cancelled' })
})

it.skipIf(process.platform !== 'win32')(
  'contains synchronous cleanup spawn failure on timeout',
  async () => {
    vi.useFakeTimers()
    Object.assign(child, { pid: 43210 })
    mocks.spawn
      .mockImplementationOnce(() => child)
      .mockImplementationOnce(() => {
        throw new Error('SYNTHETIC_CLEANUP_SPAWN_FAILURE')
      })
    const pending = executeDirectOfficeHelper(config(), input())
    for (let attempt = 0; attempt < 50 && !mocks.spawn.mock.calls.length; attempt++)
      await Promise.resolve()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    child.emit('spawn')
    let cleanupError: unknown
    try {
      await vi.advanceTimersByTimeAsync(1000)
    } catch (error) {
      cleanupError = error
    }
    child.emit('close', null)
    await pending
    expect(cleanupError).toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  }
)

it.skipIf(process.platform !== 'win32')(
  'waits for actual close when cleanup launch and fallback kill both throw',
  async () => {
    vi.useFakeTimers()
    Object.assign(child, { pid: 43210 })
    child.kill.mockImplementation(() => {
      throw new Error('PRIVATE_KILL_FAILURE')
    })
    mocks.spawn
      .mockImplementationOnce(() => child)
      .mockImplementation(() => {
        throw new Error('PRIVATE_CLEANUP_FAILURE')
      })
    let settled = false
    const pending = executeDirectOfficeHelper(config(), input()).then((result) => {
      settled = true
      return result
    })
    for (let attempt = 0; attempt < 50 && !mocks.spawn.mock.calls.length; attempt++)
      await Promise.resolve()
    child.emit('spawn')
    await expect(vi.advanceTimersByTimeAsync(4000)).resolves.toBeDefined()
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)
    expect(receipts.map((receipt) => receipt.lifecycle)).toEqual(['started'])
    child.emit('close', null)
    expect(await pending).toMatchObject({ outcome: 'timed_out', exitCode: null })
    expect(JSON.stringify(receipts)).not.toContain('PRIVATE_')
  }
)

it('rejects shell-only requests instead of inferring a nested helper', async () => {
  await expect(
    executeDirectOfficeHelper(config(), {
      ...input(),
      helper: undefined,
      command: 'python wrapper.py'
    } as unknown as DirectOfficeHelperInput)
  ).rejects.toThrow('Unknown Office helper')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toEqual([])
})

it('rechecks main-owned authorization after filesystem validation and before spawn', async () => {
  await expect(
    executeDirectOfficeHelper({ ...config(), authorize: () => false }, input())
  ).rejects.toThrow('authorization changed')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toEqual([])
})

it('does not spawn when cancellation arrives during asynchronous filesystem validation', async () => {
  const controller = new AbortController()
  mocks.readFile.mockImplementation(async () => {
    controller.abort()
    return bytes
  })
  await expect(
    executeDirectOfficeHelper(config(), { ...input(), signal: controller.signal })
  ).resolves.toMatchObject({ outcome: 'cancelled', exitCode: null })
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toHaveLength(1)
  expect(receipts[0].lifecycle).toBe('finished')
})

it('rejects malformed argv and relative interpreter configuration', async () => {
  await expect(
    executeDirectOfficeHelper(config(), {
      ...input(),
      path: 'bad\0argument'
    } as unknown as DirectOfficeHelperInput)
  ).rejects.toThrow('configuration')
  await expect(
    executeDirectOfficeHelper({ ...config(), interpreter: 'python' }, input())
  ).rejects.toThrow('configuration')
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it.each([0, 7])('records direct process exit %i, not stdout claims', async (code) => {
  const pending = executeDirectOfficeHelper(config(), input())
  await spawned()
  child.emit('spawn')
  child.emit('close', code)
  expect(await pending).toMatchObject({
    lifecycle: 'finished',
    outcome: 'exited',
    exitCode: code,
    helperDigest: digest
  })
  expect(receipts.map((r) => r.lifecycle)).toEqual(['started', 'finished'])
  expect(receipts[0].invocationId).toBe(receipts[1].invocationId)
  expect(mocks.spawn).toHaveBeenCalledWith(
    interpreter,
    ['-B', '-s', '-E', join(root, 'office/validate.py'), join(workspace, secret)],
    expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  )
})

it('does not turn forged output or caller-supplied receipt fields into evidence', async () => {
  await expect(
    executeDirectOfficeHelper(config(), {
      ...input(),
      receipt: { outcome: 'exited' },
      stdout: '{"valid":true}',
      command: 'echo __SIDEKICK_EXIT_CODE__=0'
    } as unknown as DirectOfficeHelperInput)
  ).rejects.toThrow('configuration')
  expect(receipts).toEqual([])
  expect(mocks.spawn).not.toHaveBeenCalled()
  const pending = executeDirectOfficeHelper(config(), input())
  await spawned()
  child.emit('data', '{"valid":true}')
  expect(receipts).toEqual([])
  child.emit('error', new Error(secret))
  expect(await pending).toMatchObject({ outcome: 'spawn_error', exitCode: null })
  child.emit('close', 0)
  expect(receipts).toHaveLength(1)
})

it('keeps Docker unsupported and unverified without launching or emitting a receipt', async () => {
  expect(await executeDirectOfficeHelper(config(), { ...input(), backend: 'docker' })).toEqual({
    executionProvenance: 'unverified',
    reason: 'unsupported_backend'
  })
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toEqual([])
})

it.each(['unknown', 'toString', '../validate.py', 'pack', 'comment', 'unpack', 'recalc'])(
  'rejects non-allowlisted helper %s without receipt',
  async (helper) => {
    await expect(
      executeDirectOfficeHelper(config(), { ...input(), helper } as DirectOfficeHelperInput)
    ).rejects.toThrow('Unknown Office helper')
    expect(receipts).toEqual([])
    expect(mocks.spawn).not.toHaveBeenCalled()
  }
)

it('rejects linked/escaped helper identity before launching', async () => {
  mocks.realpath.mockImplementation(async (path) =>
    path === join(root, 'office/validate.py') ? resolve('outside-helper') : path
  )
  await expect(executeDirectOfficeHelper(config(), input())).rejects.toThrow('identity')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toEqual([])
})

it('uses a fixed preflight workflow schema and generated workspace flag', async () => {
  const pending = executeDirectOfficeHelper(
    { ...config(), expectedDigests: { preflight: digest } },
    { helper: 'preflight', workflow: 'office-validate', backend: 'host', timeoutMs: 1000 }
  )
  await spawned()
  expect(mocks.spawn.mock.calls[0][1]).toEqual([
    '-B',
    '-s',
    '-E',
    join(root, 'preflight.py'),
    'office-validate',
    '--workspace',
    workspace
  ])
  child.emit('close', 0)
  await pending
})

it.each([0, -1, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
  'rejects invalid or overflowing timeout %i before dispatch',
  async (timeoutMs) => {
    await expect(executeDirectOfficeHelper(config(), { ...input(), timeoutMs })).rejects.toThrow(
      'configuration'
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(receipts).toEqual([])
  }
)

it.each(['realpath', 'lstat', 'readFile'] as const)(
  'sanitizes %s failures without raw filesystem paths',
  async (operation) => {
    mocks[operation].mockRejectedValue(new Error(secret))
    await expect(executeDirectOfficeHelper(config(), input())).rejects.toThrow(
      'Helper filesystem validation failed'
    )
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(receipts).toEqual([])
  }
)

it.runIf(process.platform === 'win32')(
  'rejects missing, relative or linked Windows cleanup configuration',
  async () => {
    for (const windowsSystemRoot of [undefined, 'relative']) {
      await expect(
        executeDirectOfficeHelper({ ...config(), windowsSystemRoot }, input())
      ).rejects.toThrow('configuration')
    }
    mocks.realpath.mockResolvedValue(resolve('outside-taskkill'))
    await expect(executeDirectOfficeHelper(config(), input())).rejects.toThrow('cleanup executable')
    expect(mocks.spawn).not.toHaveBeenCalled()
  }
)

it.runIf(process.platform === 'win32')(
  'accepts OS canonical path casing for the trusted cleanup executable',
  async () => {
    mocks.realpath.mockImplementation(async (path: string) =>
      path.endsWith('taskkill.exe') ? path.toLowerCase() : path
    )
    const pending = executeDirectOfficeHelper(config(), input())
    await spawned()
    child.emit('close', 0)
    expect(await pending).toMatchObject({ outcome: 'exited', exitCode: 0 })
  }
)

it.each([
  { helper: 'validate', path: '../outside' },
  { helper: 'validate', path: resolve('outside') },
  { helper: 'validate', path: 'inside', args: ['--xsd'] },
  { helper: 'preflight', workflow: '-c' },
  { helper: 'preflight', workflow: 'office', interpreter: '-m evil' }
])('rejects path escapes or injected fields: %j', async (request) => {
  await expect(
    executeDirectOfficeHelper(config(), {
      backend: 'host',
      timeoutMs: 1000,
      ...request
    } as DirectOfficeHelperInput)
  ).rejects.toThrow()
  expect(receipts).toEqual([])
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('requires the configured trusted digest and a regular helper file', async () => {
  await expect(
    executeDirectOfficeHelper({ ...config(), expectedDigests: {} }, input())
  ).rejects.toThrow('digest')
  mocks.readFile.mockResolvedValue(Buffer.from('modified'))
  await expect(executeDirectOfficeHelper(config(), input())).rejects.toThrow('digest mismatch')
  mocks.lstat.mockImplementation(async (path) => ({
    isFile: () => path !== join(root, 'office/validate.py')
  }))
  await expect(executeDirectOfficeHelper(config(), input())).rejects.toThrow('identity')
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('returns pre-launch cancellation without claiming execution', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(
    await executeDirectOfficeHelper(config(), { ...input(), signal: controller.signal })
  ).toMatchObject({ outcome: 'cancelled', exitCode: null })
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(receipts).toHaveLength(1)
})

it('waits for child completion on cancellation and does not convert exit zero to success', async () => {
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  let finished = false
  const pending = executeDirectOfficeHelper(config(), {
    ...input(),
    signal: controller.signal
  }).then((r) => {
    finished = true
    return r
  })
  await spawned()
  child.emit('spawn')
  controller.abort()
  await Promise.resolve()
  expect(finished).toBe(false)
  child.emit('close', 0)
  expect(await pending).toMatchObject({ outcome: 'cancelled', exitCode: 0 })
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

it('records timeout only after the child closes', async () => {
  vi.useFakeTimers()
  const pending = executeDirectOfficeHelper(config(), input())
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.spawn).toHaveBeenCalled()
  child.emit('spawn')
  await vi.advanceTimersByTimeAsync(1000)
  expect(receipts).toHaveLength(1)
  child.emit('close', null)
  expect(await pending).toMatchObject({ outcome: 'timed_out', exitCode: null })
  expect(vi.getTimerCount()).toBe(0)
})

it('does not claim completion on an error emitted after successful spawn', async () => {
  const pending = executeDirectOfficeHelper(config(), input())
  await spawned()
  child.emit('spawn')
  child.emit('error', new Error(secret))
  expect(receipts.map((receipt) => receipt.lifecycle)).toEqual(['started'])
  child.emit('close', 1)
  expect(await pending).toMatchObject({ outcome: 'process_error', exitCode: 1 })
})

it('does not persist arguments, outputs, paths, environment or arbitrary error messages', async () => {
  vi.stubEnv('API_KEY', secret)
  const pending = executeDirectOfficeHelper(config(), input())
  await spawned()
  child.emit('error', new Error(secret))
  await pending
  const serialized = JSON.stringify(receipts)
  for (const value of [secret, root, interpreter, 'stdout', 'stderr', 'args', 'env'])
    expect(serialized).not.toContain(value)
  expect(mocks.spawn.mock.calls[0][2].env.API_KEY).toBeUndefined()
  expect(Object.isFrozen(receipts[0])).toBe(true)
})

it('surfaces observer failure only after process settlement', async () => {
  const pending = executeDirectOfficeHelper(
    {
      ...config(),
      observe: () => {
        throw new Error(secret)
      }
    },
    input()
  )
  const rejected = expect(pending).rejects.toThrow('Helper receipt observer failed')
  await spawned()
  child.emit('spawn')
  child.emit('close', 0)
  await rejected
})

it('handles synchronous spawn failure without exposing its message', async () => {
  mocks.spawn.mockImplementation(() => {
    throw new Error(secret)
  })
  expect(await executeDirectOfficeHelper(config(), input())).toMatchObject({
    outcome: 'spawn_error',
    exitCode: null
  })
  expect(JSON.stringify(receipts)).not.toContain(secret)
})
