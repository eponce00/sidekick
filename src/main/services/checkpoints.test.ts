import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  beginCheckpointCapture,
  configureCheckpointStorageRoot,
  createCheckpoint,
  deleteShadowRepo,
  getCheckpointDiff,
  getHistoryStatus,
  hardResetCheckpoint,
  initShadowRepo,
  listCheckpoints,
  recoverInterruptedCheckpointCaptures,
  restoreCheckpoint,
  rewindToBeforeCheckpoint,
  rewindWorkspacesToBeforeCheckpoints
} from './checkpoints'

const execFileAsync = promisify(execFile)
const GIT_INTEGRATION_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 10_000

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

describe('private SideKick workspace history', () => {
  let testRoot: string
  let workspace: string
  let storage: string

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(join(tmpdir(), 'sidekick-history-'))
    workspace = join(testRoot, 'workspace')
    storage = join(testRoot, 'app-data', 'history')
    await fs.mkdir(workspace, { recursive: true })
    configureCheckpointStorageRoot(storage)
  })

  afterEach(async () => {
    await fs.rm(testRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  })

  async function captureAndCreate(message: string, mutate: () => Promise<void>): Promise<string> {
    const captureId = await beginCheckpointCapture(workspace, 'conversation-1', crypto.randomUUID())
    await mutate()
    const checkpoint = await createCheckpoint(workspace, message, captureId)
    expect(checkpoint).not.toBeNull()
    return checkpoint!.hash
  }

  it('stores its repository outside the project and never mutates a real Git repository', async () => {
    await write(join(workspace, 'tracked.txt'), 'original\n')
    await execFileAsync('git', ['init', workspace])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'test@example.com'])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Test User'])
    await execFileAsync('git', ['-C', workspace, 'add', 'tracked.txt'])
    await execFileAsync('git', ['-C', workspace, 'commit', '-m', 'Initial'])
    const beforeHead = (
      await execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD'])
    ).stdout.trim()
    const beforeIndex = (await execFileAsync('git', ['-C', workspace, 'diff', '--cached'])).stdout

    const hash = await captureAndCreate('Update tracked file', async () => {
      await write(join(workspace, 'tracked.txt'), 'changed by SideKick\n')
    })

    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    await expect(fs.access(join(workspace, '.sidekick', 'checkpoints.git'))).rejects.toThrow()
    expect((await execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(
      beforeHead
    )
    expect((await execFileAsync('git', ['-C', workspace, 'diff', '--cached'])).stdout).toBe(
      beforeIndex
    )
    expect(await getHistoryStatus(workspace)).toMatchObject({
      storage: 'private-app-data',
      realRepository: true,
      appliedHash: hash
    })
    expect(await getCheckpointDiff(workspace, hash)).toContain('tracked.txt')
  }, 15_000)

  it('records only the delta after the per-run baseline', async () => {
    await write(join(workspace, 'manual-before.txt'), 'manual work\n')
    await write(join(workspace, 'agent.txt'), 'before\n')

    const hash = await captureAndCreate('Agent edit', async () => {
      await write(join(workspace, 'agent.txt'), 'after\n')
    })
    const diff = await getCheckpointDiff(workspace, hash)

    expect(diff).toContain('agent.txt')
    expect(diff).not.toContain('manual-before.txt')
    expect((await listCheckpoints(workspace))[0]).toMatchObject({
      hash,
      changeCount: 1,
      captureVersion: 2
    })
  }, 15_000)

  it('recovers a persisted pre-mutation capture after an interrupted run', async () => {
    await write(join(workspace, 'agent.txt'), 'before\n')
    const captureId = await beginCheckpointCapture(workspace, 'conversation-1', 'assistant-1')
    await write(join(workspace, 'agent.txt'), 'partial change\n')

    const recovered = await recoverInterruptedCheckpointCaptures()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      conversationId: 'conversation-1',
      agentMessageId: 'assistant-1',
      workspaceRoot: workspace,
      checkpoint: { changeCount: 1, captureVersion: 2 }
    })
    expect(await getCheckpointDiff(workspace, recovered[0].checkpoint.hash)).toContain(
      'partial change'
    )
    await expect(createCheckpoint(workspace, 'Duplicate recovery', captureId)).rejects.toThrow(
      'History capture expired'
    )
  })

  it('preserves unrelated manual files when undoing SideKick changes', async () => {
    await write(join(workspace, 'agent.txt'), 'before\n')
    const hash = await captureAndCreate('Agent edit', async () => {
      await write(join(workspace, 'agent.txt'), 'after\n')
    })
    await write(join(workspace, 'manual-after.txt'), 'keep me\n')

    const result = await rewindToBeforeCheckpoint(workspace, hash)

    expect(result).toMatchObject({ ok: true, changedFiles: 1, parentHash: null })
    expect(await fs.readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('before\n')
    expect(await fs.readFile(join(workspace, 'manual-after.txt'), 'utf8')).toBe('keep me\n')
  })

  it('blocks the entire restore when an affected file changed later', async () => {
    await write(join(workspace, 'one.txt'), 'before one\n')
    await write(join(workspace, 'two.txt'), 'before two\n')
    const hash = await captureAndCreate('Edit two files', async () => {
      await write(join(workspace, 'one.txt'), 'agent one\n')
      await write(join(workspace, 'two.txt'), 'agent two\n')
    })
    await write(join(workspace, 'two.txt'), 'manual later\n')

    const result = await rewindToBeforeCheckpoint(workspace, hash)

    expect(result.ok).toBe(false)
    expect(result.conflicts).toContainEqual({ path: 'two.txt', reason: 'changed-after' })
    expect(await fs.readFile(join(workspace, 'one.txt'), 'utf8')).toBe('agent one\n')
    expect(await fs.readFile(join(workspace, 'two.txt'), 'utf8')).toBe('manual later\n')
  })

  it('treats staged real-Git files as protected and leaves the real index intact', async () => {
    await write(join(workspace, 'agent.txt'), 'before\n')
    await execFileAsync('git', ['init', workspace])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.email', 'test@example.com'])
    await execFileAsync('git', ['-C', workspace, 'config', 'user.name', 'Test User'])
    await execFileAsync('git', ['-C', workspace, 'add', 'agent.txt'])
    await execFileAsync('git', ['-C', workspace, 'commit', '-m', 'Initial'])
    const hash = await captureAndCreate('Agent edit', async () => {
      await write(join(workspace, 'agent.txt'), 'after\n')
    })
    await execFileAsync('git', ['-C', workspace, 'add', 'agent.txt'])
    const stagedBefore = (await execFileAsync('git', ['-C', workspace, 'diff', '--cached'])).stdout

    const result = await rewindToBeforeCheckpoint(workspace, hash)

    expect(result.ok).toBe(false)
    expect(result.conflicts).toContainEqual({ path: 'agent.txt', reason: 'staged-in-git' })
    expect((await execFileAsync('git', ['-C', workspace, 'diff', '--cached'])).stdout).toBe(
      stagedBefore
    )
    expect(await fs.readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('after\n')
  })

  it(
    'supports reversible soft restores and branches new work from the applied point',
    async () => {
      await write(join(workspace, 'state.txt'), 'zero\n')
      const first = await captureAndCreate('First', async () => {
        await write(join(workspace, 'state.txt'), 'one\n')
      })
      const second = await captureAndCreate('Second', async () => {
        await write(join(workspace, 'state.txt'), 'two\n')
      })

      expect(await restoreCheckpoint(workspace, first)).toMatchObject({ ok: true, changedFiles: 1 })
      expect(await fs.readFile(join(workspace, 'state.txt'), 'utf8')).toBe('one\n')
      expect(await restoreCheckpoint(workspace, second)).toMatchObject({
        ok: true,
        changedFiles: 1
      })
      expect(await fs.readFile(join(workspace, 'state.txt'), 'utf8')).toBe('two\n')

      expect(await restoreCheckpoint(workspace, first)).toMatchObject({ ok: true })
      const replacement = await captureAndCreate('Replacement', async () => {
        await write(join(workspace, 'state.txt'), 'three\n')
      })
      const entries = await listCheckpoints(workspace)
      expect(entries.map(({ hash }) => hash)).toEqual([replacement, first])
      await expect(hardResetCheckpoint(workspace, second)).rejects.toThrow(
        'History point not found'
      )
    },
    GIT_INTEGRATION_TIMEOUT_MS
  )

  it(
    'rewinds multiple project histories atomically to before their affected checkpoints',
    async () => {
      const secondWorkspace = join(testRoot, 'second-workspace')
      await fs.mkdir(secondWorkspace, { recursive: true })
      await write(join(workspace, 'state.txt'), 'before a\n')
      await write(join(secondWorkspace, 'state.txt'), 'before b\n')
      const firstCapture = await beginCheckpointCapture(workspace, 'group', 'run-a')
      const secondCapture = await beginCheckpointCapture(secondWorkspace, 'group', 'run-b')
      await write(join(workspace, 'state.txt'), 'agent a\n')
      await write(join(secondWorkspace, 'state.txt'), 'agent b\n')
      const first = (await createCheckpoint(workspace, 'Agent A', firstCapture))!
      const second = (await createCheckpoint(secondWorkspace, 'Agent B', secondCapture))!

      const result = await rewindWorkspacesToBeforeCheckpoints([
        { workspaceRoot: workspace, checkpointHash: first.hash },
        { workspaceRoot: secondWorkspace, checkpointHash: second.hash }
      ])

      expect(result.ok).toBe(true)
      expect(await fs.readFile(join(workspace, 'state.txt'), 'utf8')).toBe('before a\n')
      expect(await fs.readFile(join(secondWorkspace, 'state.txt'), 'utf8')).toBe('before b\n')
      expect(await listCheckpoints(workspace)).toEqual([])
      expect(await listCheckpoints(secondWorkspace)).toEqual([])
    },
    GIT_INTEGRATION_TIMEOUT_MS
  )

  it(
    'leaves every project untouched when any coordinated rewind has a conflict',
    async () => {
      const secondWorkspace = join(testRoot, 'second-workspace')
      await fs.mkdir(secondWorkspace, { recursive: true })
      await write(join(workspace, 'state.txt'), 'before a\n')
      await write(join(secondWorkspace, 'state.txt'), 'before b\n')
      const firstCapture = await beginCheckpointCapture(workspace, 'group', 'run-a')
      const secondCapture = await beginCheckpointCapture(secondWorkspace, 'group', 'run-b')
      await write(join(workspace, 'state.txt'), 'agent a\n')
      await write(join(secondWorkspace, 'state.txt'), 'agent b\n')
      const first = (await createCheckpoint(workspace, 'Agent A', firstCapture))!
      const second = (await createCheckpoint(secondWorkspace, 'Agent B', secondCapture))!
      await write(join(secondWorkspace, 'state.txt'), 'manual b\n')

      const result = await rewindWorkspacesToBeforeCheckpoints([
        { workspaceRoot: workspace, checkpointHash: first.hash },
        { workspaceRoot: secondWorkspace, checkpointHash: second.hash }
      ])

      expect(result).toMatchObject({
        ok: false,
        conflicts: [
          {
            workspaceRoot: secondWorkspace,
            path: 'state.txt',
            reason: 'changed-after'
          }
        ]
      })
      expect(await fs.readFile(join(workspace, 'state.txt'), 'utf8')).toBe('agent a\n')
      expect(await fs.readFile(join(secondWorkspace, 'state.txt'), 'utf8')).toBe('manual b\n')
      expect((await getHistoryStatus(workspace)).appliedHash).toBe(first.hash)
      expect((await getHistoryStatus(secondWorkspace)).appliedHash).toBe(second.hash)
    },
    GIT_INTEGRATION_TIMEOUT_MS
  )

  it('migrates the obsolete in-project store without deleting project rules', async () => {
    const legacy = join(workspace, '.sidekick', 'checkpoints.git')
    await fs.mkdir(join(workspace, '.sidekick'), { recursive: true })
    await write(join(workspace, '.sidekick', 'rules.md'), '# Keep this\n')
    await execFileAsync('git', ['init', '--bare', legacy])

    await initShadowRepo(workspace)
    await expect(fs.access(legacy)).rejects.toThrow()
    expect(await fs.readFile(join(workspace, '.sidekick', 'rules.md'), 'utf8')).toBe(
      '# Keep this\n'
    )

    await deleteShadowRepo(workspace)
    expect(await fs.readFile(join(workspace, '.sidekick', 'rules.md'), 'utf8')).toBe(
      '# Keep this\n'
    )
  })
})
