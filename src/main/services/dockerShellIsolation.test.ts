import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const docker = vi.hoisted(() => vi.fn())
const metadata = vi.hoisted(() => vi.fn())
vi.mock('node:util', () => ({ promisify: () => docker }))
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path, lstat: metadata }))
import { isolatedShellProcess, SHELL_SANDBOX_IMAGE } from './dockerShellIsolation'

const root = resolve('fixture-project')
const input = () => ({
  id: 'test-123',
  workspaceRoot: root,
  cwd: root,
  command: 'echo ok',
  env: {}
})
beforeEach(() => {
  docker.mockReset()
  metadata.mockReset().mockImplementation(async (path: string) => ({
    isDirectory: () => !path.endsWith('.py'),
    isFile: () => path.endsWith('.py'),
    isSymbolicLink: () => false
  }))
  docker.mockImplementation(async (_file, args: string[]) => ({
    stdout:
      args[0] === 'context' ? 'unix:///var/run/docker.sock' : args[0] === 'info' ? 'linux' : '',
    stderr: ''
  }))
})

describe('isolated shell launch policy', () => {
  it('never mounts an ambient helper variable or propagates host credentials', async () => {
    const launch = await isolatedShellProcess({
      ...input(),
      env: { SIDEKICK_SKILLS: '/private/home', OPENAI_API_KEY: 'fixture-secret' }
    })
    expect(launch.args.join(' ')).not.toContain('/private/home')
    expect(launch.args.join(' ')).not.toContain('fixture-secret')
    expect(launch.args.join(' ')).not.toContain('SIDEKICK_SKILLS=')
  })
  it.each([
    root,
    resolve('resources'),
    resolve('app/resources/skills,unsafe'),
    resolve('app/resources/skills"unsafe'),
    resolve('app/resources/skills\nunsafe'),
    'relative/resources/skills'
  ])('rejects unsafe or broad configured helper mounts: %s', async (path) => {
    await expect(isolatedShellProcess({ ...input(), skillAssetsPath: path })).rejects.toThrow(
      /helper mount/
    )
  })
  it('rejects missing bundle markers instead of widening the mount', async () => {
    metadata.mockRejectedValue(new Error('missing fixture marker'))
    await expect(
      isolatedShellProcess({ ...input(), skillAssetsPath: resolve('app/resources/skills') })
    ).rejects.toThrow('missing fixture marker')
  })
  it('rejects a linked helper root', async () => {
    metadata.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => true })
    await expect(
      isolatedShellProcess({ ...input(), skillAssetsPath: resolve('app/resources/skills') })
    ).rejects.toThrow('real directory')
  })
  it('rejects a linked bundle marker', async () => {
    metadata.mockImplementation(async (path: string) => ({
      isDirectory: () => !path.endsWith('.py'),
      isFile: () => path.endsWith('.py'),
      isSymbolicLink: () => path.endsWith('.py')
    }))
    await expect(
      isolatedShellProcess({ ...input(), skillAssetsPath: resolve('app/resources/skills') })
    ).rejects.toThrow('incomplete or linked')
  })
  it('rejects remote daemons before inspecting images or launching', async () => {
    await expect(
      isolatedShellProcess({ ...input(), env: { DOCKER_HOST: 'tcp://remote:2375' } })
    ).rejects.toThrow('local Docker daemon')
    expect(docker).not.toHaveBeenCalled()
  })
  it('rejects conflicting endpoint overrides', async () => {
    await expect(
      isolatedShellProcess({
        ...input(),
        env: { DOCKER_HOST: 'unix:///socket', DOCKER_CONTEXT: 'other' }
      })
    ).rejects.toThrow('Ambiguous')
  })
  it('fails closed when the pinned image is unavailable', async () => {
    docker.mockImplementation(async (_file, args: string[]) => {
      if (args[0] === 'image') throw new Error('missing')
      return { stdout: args[0] === 'context' ? 'unix:///socket' : 'linux' }
    })
    await expect(isolatedShellProcess(input())).rejects.toThrow(
      `docker pull ${SHELL_SANDBOX_IMAGE}`
    )
    expect(docker.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false)
  })
  it('rejects cwd outside the project', async () => {
    await expect(
      isolatedShellProcess({ ...input(), cwd: resolve(root, '..', 'other') })
    ).rejects.toThrow('escapes')
  })
  it('keeps the command a single argument and bounds container lifetime', async () => {
    const command = 'echo "hello"; echo "$HOME"'
    const launch = await isolatedShellProcess({ ...input(), command, timeoutSecs: 2 })
    expect(launch.file).toBe('docker')
    expect(launch.args.slice(-3)).toEqual(['/bin/sh', '-c', command])
    expect(launch.args).toContain('2s')
    expect(launch.args).toContain('--network')
    expect(launch.args).toContain('none')
    expect(launch.args).toContain(SHELL_SANDBOX_IMAGE)
    await launch.cleanup()
    expect(
      docker.mock.calls.some(([, args]) => args.join(' ') === 'rm --force sidekick-shell-test-123')
    ).toBe(true)
  })
})
