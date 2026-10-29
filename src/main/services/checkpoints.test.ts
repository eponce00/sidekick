// Over the 30-second budget on Windows (about 50 s): every case runs the real Git commands of
// the history store, about 40 a checkpoint at some 100 ms each. The git project in
// vitest.config.ts runs it beside the rest of the suite.
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
  initShadowRepo,
  recoverInterruptedCheckpointCaptures,
  restoreWorkspaceHistory
} from './checkpoints'

const execFileAsync = promisify(execFile)

/** One folder back to before a point, as the window's Undo does it. */
const rewindBefore = (workspaceRoot: string, hash: string) =>
  restoreWorkspaceHistory([{ workspaceRoot, hashes: [hash] }])

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
  })

  it('records and undoes only the delta after the per-run baseline, keeping manual files', async () => {
    await write(join(workspace, 'manual-before.txt'), 'manual work\n')
    await write(join(workspace, 'agent.txt'), 'before\n')

    const captureId = await beginCheckpointCapture(workspace, 'conversation-1', 'assistant-1')
    await write(join(workspace, 'agent.txt'), 'after\n')
    const checkpoint = await createCheckpoint(workspace, 'Agent edit', captureId)
    expect(checkpoint).toMatchObject({ changeCount: 1, captureVersion: 2 })
    await write(join(workspace, 'manual-after.txt'), 'keep me\n')

    const result = await rewindBefore(workspace, checkpoint!.hash)

    expect(result).toMatchObject({ ok: true, workspaces: [{ changedFiles: 1, nextRef: null }] })
    expect(await fs.readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('before\n')
    expect(await fs.readFile(join(workspace, 'manual-before.txt'), 'utf8')).toBe('manual work\n')
    expect(await fs.readFile(join(workspace, 'manual-after.txt'), 'utf8')).toBe('keep me\n')
  })

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
    await expect(createCheckpoint(workspace, 'Duplicate recovery', captureId)).rejects.toThrow(
      'History capture expired'
    )
  })

  it('blocks the entire restore when an affected file changed later', async () => {
    await write(join(workspace, 'one.txt'), 'before one\n')
    await write(join(workspace, 'two.txt'), 'before two\n')
    const hash = await captureAndCreate('Edit two files', async () => {
      await write(join(workspace, 'one.txt'), 'agent one\n')
      await write(join(workspace, 'two.txt'), 'agent two\n')
    })
    await write(join(workspace, 'two.txt'), 'manual later\n')

    const result = await rewindBefore(workspace, hash)

    expect(result).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ path: 'two.txt', reason: 'changed-after' })]
    })
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

    const result = await rewindBefore(workspace, hash)

    expect(result).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ path: 'agent.txt', reason: 'staged-in-git' })]
    })
    expect((await execFileAsync('git', ['-C', workspace, 'diff', '--cached'])).stdout).toBe(
      stagedBefore
    )
    expect(await fs.readFile(join(workspace, 'agent.txt'), 'utf8')).toBe('after\n')
  })

  it('rewinds several projects together, or leaves every one untouched on a conflict', async () => {
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

    const result = await restoreWorkspaceHistory([
      { workspaceRoot: workspace, hashes: [first.hash] },
      { workspaceRoot: secondWorkspace, hashes: [second.hash] }
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

    // Neither timeline moved, so once the conflict is gone both rewind together.
    await write(join(secondWorkspace, 'state.txt'), 'agent b\n')
    expect(
      await restoreWorkspaceHistory([
        { workspaceRoot: workspace, hashes: [first.hash] },
        { workspaceRoot: secondWorkspace, hashes: [second.hash] }
      ])
    ).toMatchObject({ ok: true })
    expect(await fs.readFile(join(workspace, 'state.txt'), 'utf8')).toBe('before a\n')
    expect(await fs.readFile(join(secondWorkspace, 'state.txt'), 'utf8')).toBe('before b\n')
    // Both points are undone now, so nothing is left to take back.
    expect(await rewindBefore(workspace, first.hash)).toEqual({ ok: true, workspaces: [] })
    expect(await rewindBefore(secondWorkspace, second.hash)).toEqual({ ok: true, workspaces: [] })
  })

  it('rewinds each folder before its earliest point still in History, passing over undone ones', async () => {
    // Reply 1 changed the other folder and was undone; reply 2 changed both. Going back to before
    // reply 1's message takes back reply 2 in both folders, and nothing of reply 1 twice.
    const other = join(testRoot, 'other-folder')
    await fs.mkdir(other, { recursive: true })
    await write(join(workspace, 'app.txt'), 'start\n')
    await write(join(other, 'lib.txt'), 'start\n')
    const firstCapture = await beginCheckpointCapture(other, 'chat', 'reply-1')
    await write(join(other, 'lib.txt'), 'first\n')
    const first = (await createCheckpoint(other, 'First reply', firstCapture))!
    expect(await rewindBefore(other, first.hash)).toMatchObject({ ok: true })
    const primaryCapture = await beginCheckpointCapture(workspace, 'chat', 'reply-2')
    const otherCapture = await beginCheckpointCapture(other, 'chat', 'reply-2')
    await write(join(workspace, 'app.txt'), 'second\n')
    await write(join(other, 'lib.txt'), 'second\n')
    const primaryPoint = (await createCheckpoint(workspace, 'Second reply', primaryCapture))!
    const otherPoint = (await createCheckpoint(other, 'Second reply', otherCapture))!

    const result = await restoreWorkspaceHistory([
      { workspaceRoot: workspace, hashes: [primaryPoint.hash] },
      { workspaceRoot: other, hashes: [first.hash, otherPoint.hash] }
    ])

    expect(result).toMatchObject({ ok: true })
    expect(await fs.readFile(join(workspace, 'app.txt'), 'utf8')).toBe('start\n')
    expect(await fs.readFile(join(other, 'lib.txt'), 'utf8')).toBe('start\n')
    // Nothing is left to take back, so a second rewind changes nothing.
    expect(
      await restoreWorkspaceHistory([
        { workspaceRoot: other, hashes: [first.hash, otherPoint.hash] }
      ])
    ).toEqual({ ok: true, workspaces: [] })
  })

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
