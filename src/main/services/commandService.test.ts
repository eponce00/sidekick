import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CommandService, projectRelativeCommandCwd, shellChildEnvironment } from './commandService'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()))
})

async function waitForBackground(
  service: CommandService,
  runId: string,
  timeoutMs = 5_000
): Promise<ReturnType<CommandService['listBackground']>[number]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = service.listBackground(runId)[0]
    if (task && task.status !== 'running') return task
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Background task for ${runId} did not settle within ${timeoutMs}ms`)
}

async function setup(): Promise<{ root: string; service: CommandService; db: Database.Database }> {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-command-service-'))
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const service = new CommandService(db, join(root, 'outputs'))
  cleanup.push(() => {
    service.cancelAll()
    db.close()
  })
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return { root, service, db }
}

describe('CommandService', () => {
  it('scrubs ambient credentials and injects managed workspace paths', () => {
    const environment = shellChildEnvironment(
      {
        PATH: 'bin',
        OPENAI_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        ORDINARY_SETTING: 'visible'
      },
      'C:\\workspace',
      'C:\\scratch',
      'C:\\SideKick\\skills'
    )

    expect(environment).toMatchObject({
      PATH: 'bin',
      ORDINARY_SETTING: 'visible',
      WORKSPACE_FOLDER: 'C:\\workspace',
      SIDEKICK_WORKSPACE: 'C:\\workspace',
      SIDEKICK_SCRATCH: 'C:\\scratch',
      SIDEKICK_SKILLS: 'C:\\SideKick\\skills'
    })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
  })

  it('executes foreground commands within the project', async () => {
    const { root, service } = await setup()
    const result = await service.execute({
      runId: 'run-1',
      title: 'Print directory',
      command: process.platform === 'win32' ? 'Write-Output $PWD.Path' : 'pwd',
      workspaceRoot: root
    })
    expect('success' in result && result.success).toBe(true)
    expect('stdout' in result && result.stdout.trim()).toBe(await realpath(root))
  })

  it('accepts an absolute cwd when it resolves inside the active project', async () => {
    const { root, service } = await setup()
    const result = await service.execute({
      runId: 'run-absolute-cwd',
      title: 'Print directory',
      command: process.platform === 'win32' ? 'Write-Output $PWD.Path' : 'pwd',
      workspaceRoot: root,
      cwd: root
    })

    expect(projectRelativeCommandCwd(root, root)).toBe('')
    expect('success' in result && result.success).toBe(true)
    expect('stdout' in result && result.stdout.trim()).toBe(await realpath(root))
  })

  it('owns background tasks by run and persists completion', async () => {
    const { root, service, db } = await setup()
    const task = await service.execute({
      runId: 'run-2',
      title: 'Background output',
      command: process.platform === 'win32' ? 'Write-Output done' : 'printf done',
      workspaceRoot: root,
      background: true
    })
    expect('runId' in task && task.runId).toBe('run-2')
    if (!('runId' in task)) throw new Error('Expected a background task')
    const completed = await waitForBackground(service, 'run-2')
    expect(completed.status).toBe('success')
    expect(service.listBackground('run-2')).toHaveLength(1)
    expect(service.listBackground('another-run')).toHaveLength(0)
    const row = db.prepare('SELECT status FROM background_tasks WHERE id = ?').get(task.id) as {
      status: string
    }
    expect(row.status).toBe('success')
  })

  it('rejects a working directory outside the project', async () => {
    const { root, service } = await setup()
    await expect(
      service.execute({
        runId: 'run-3',
        title: 'Escape',
        command: 'pwd',
        workspaceRoot: root,
        cwd: '..'
      })
    ).rejects.toThrow(/outside|escapes/i)
  })
})
