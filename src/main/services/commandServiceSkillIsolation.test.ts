import Database from 'better-sqlite3'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'

const mocks = vi.hoisted(() => ({ docker: vi.fn(), run: vi.fn() }))
vi.mock('node:util', () => ({ promisify: () => mocks.docker }))
vi.mock('./commandRunner', () => ({
  CommandRunner: class {
    run = mocks.run
    cancelAll() {
      return undefined
    }
  }
}))
import { CommandService } from './commandService'

it('maps only configured bundled helpers read-only into the isolated container', async () => {
  vi.stubEnv('DOCKER_HOST', 'unix:///synthetic/docker.sock')
  vi.stubEnv('DOCKER_CONTEXT', '')
  const root = await mkdtemp(join(tmpdir(), 'sidekick-skill-isolation-'))
  const workspace = join(root, 'workspace')
  const helpers = join(root, 'app with spaces', 'resources', 'skills')
  await mkdir(workspace)
  await mkdir(join(helpers, 'office'), { recursive: true })
  await writeFile(join(helpers, 'preflight.py'), '# synthetic')
  await writeFile(join(helpers, 'office/validate.py'), '# synthetic')
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  mocks.run.mockReset().mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' })
  mocks.docker.mockReset().mockImplementation(async (_file: string, args: string[]) => ({
    stdout:
      args[0] === 'context' ? 'unix:///synthetic/docker.sock' : args[0] === 'info' ? 'linux' : '',
    stderr: ''
  }))
  const host = new CommandService(db, join(root, 'host'), undefined, helpers, () => false)
  const isolated = new CommandService(db, join(root, 'isolated'), undefined, helpers, () => true)
  const command = 'printf "%s" "$SIDEKICK_SKILLS"'
  const request = {
    runId: 'fixture-run',
    title: 'Inspect helper environment',
    workspaceRoot: workspace,
    command
  }
  try {
    await host.execute(request)
    const hostLaunch = mocks.run.mock.calls[0][0]
    expect(hostLaunch.env.SIDEKICK_SKILLS).toBe(helpers)
    expect(hostLaunch.process).toBeUndefined()

    await isolated.execute(request)
    const isolatedLaunch = mocks.run.mock.calls[1][0]
    // This environment belongs to the host Docker CLI process, NOT its container.
    expect(isolatedLaunch.env.SIDEKICK_SKILLS).toBe(helpers)
    expect(isolatedLaunch.process.file).toBe('docker')
    const args: string[] = isolatedLaunch.process.args
    const valuesAfter = (flag: string) =>
      args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []))
    expect(valuesAfter('--env')).toEqual(['SIDEKICK_SKILLS=/sidekick-skills', 'HOME=/tmp'])
    expect(valuesAfter('--mount')).toHaveLength(2)
    expect(valuesAfter('--mount')[0]).toContain('dst=/workspace')
    expect(valuesAfter('--mount')[1]).toBe(
      `type=bind,src=${await realpath(helpers)},dst=/sidekick-skills,readonly,bind-recursive=disabled`
    )
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', command])
    expect(args).toContain('--pull=never')
    expect(
      mocks.docker.mock.calls.every(([, argv]) => !['run', 'pull', 'build'].includes(argv[0]))
    ).toBe(true)
  } finally {
    host.cancelAll()
    isolated.cancelAll()
    db.close()
    await rm(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
