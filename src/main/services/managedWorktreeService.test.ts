import { execFile } from 'child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile, access, chmod, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ProjectStore } from './projectStore'
import { ManagedWorktreeService } from './managedWorktreeService'
import type { ManagedWorktreeSummary } from '../../shared/worktrees'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout.trim()
}

function addChat(db: Database.Database, id: string, projectId: string, title = 'Chat'): void {
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, project_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, title, Date.now(), Date.now(), projectId)
}

/** A chat in its project that works in its own worktree of it. */
function addWorktreeChat(
  db: Database.Database,
  id: string,
  worktree: ManagedWorktreeSummary,
  title = 'Chat'
): void {
  addChat(db, id, worktree.sourceProjectId, title)
  db.prepare('UPDATE conversations SET worktree_id = ? WHERE id = ?').run(worktree.id, id)
}

function markRunning(db: Database.Database, conversationId: string): void {
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
     VALUES (?, ?, 'conversation', 'streaming', 'test', 'test', '{}', ?, ?)`
  ).run(`run-${conversationId}`, conversationId, Date.now(), Date.now())
}

/**
 * Turns a new worktree into one made before worktrees started detached, when SideKick created a
 * branch for each: checked out in it and recorded as its branch.
 */
async function giveLegacyBranch(
  db: Database.Database,
  worktree: ManagedWorktreeSummary,
  branch: string
): Promise<void> {
  await git(worktree.folderPath, ['switch', '-c', branch])
  db.prepare('UPDATE managed_worktrees SET branch = ? WHERE id = ?').run(branch, worktree.id)
}

async function commitFile(cwd: string, file: string, content: string): Promise<void> {
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await git(cwd, ['-c', 'user.email=t@test.local', '-c', 'user.name=T', 'commit', '-m', file])
}

describe('ManagedWorktreeService', () => {
  let db: Database.Database
  let root: string
  let storage: string

  beforeEach(async () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    root = await mkdtemp(join(tmpdir(), 'sidekick-worktree-source-'))
    storage = await mkdtemp(join(tmpdir(), 'sidekick-worktree-storage-'))
    await git(root, ['init'])
    await git(root, ['config', 'user.email', 'sidekick@test.local'])
    await git(root, ['config', 'user.name', 'SideKick Test'])
    await writeFile(join(root, 'README.md'), 'source\n', 'utf8')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'initial'])
    // Compare file contents exactly on Windows too.
    await git(root, ['config', 'core.autocrlf', 'false'])
  })

  afterEach(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  })

  it('creates a worktree detached at the source commit, with no new branch or project', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const branchesBefore = await git(root, ['branch', '--list'])
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Fix cards')

    expect(project.folderPath.startsWith(storage)).toBe(true)
    // Detached: the base branch stays checked out in the project folder, where it already is.
    expect(await git(project.folderPath, ['branch', '--show-current'])).toBe('')
    expect(await git(project.folderPath, ['rev-parse', 'HEAD'])).toBe(
      await git(root, ['rev-parse', 'HEAD'])
    )
    expect(await git(root, ['branch', '--list'])).toBe(branchesBefore)
    const [worktree] = await service.list()
    expect(worktree.branch).toBeNull()
    expect(worktree.status).toEqual({ currentBranch: null, ahead: 0, changedFiles: 0 })
    expect(worktree.setAsideAt).toBeNull()
    expect(worktree).toMatchObject({ sourceProjectId: source.id, sourceProjectName: 'Example' })
    expect(await git(root, ['status', '--porcelain'])).toBe('')
    // The worktree is the chat's folder, not a project of its own.
    expect(new ProjectStore(db).list().map(({ id }) => id)).toEqual([source.id])
  })

  it('rejects isolated forks for non-Git projects', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'sidekick-plain-project-'))
    try {
      const source = new ProjectStore(db).create(plain, 'Plain')
      await expect(
        new ManagedWorktreeService(db, storage).create(source.id, 'Fork')
      ).rejects.toThrow('requires a Git project')
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
  it('removes a clean fresh checkout but preserves the source', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Clean')
    await service.discardFresh(project.id)
    await expect(access(project.folderPath)).rejects.toThrow()
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('source\n')
  })
  it('does not execute repository checkout hooks during managed creation', async () => {
    const hook = join(root, '.git', 'hooks', 'post-checkout')
    const marker = join(root, 'hook-ran.txt')
    await writeFile(hook, `#!/bin/sh\necho unexpected > '${marker.replaceAll('\\', '/')}'\n`)
    await chmod(hook, 0o755)
    const source = new ProjectStore(db).create(root, 'Example')
    await new ManagedWorktreeService(db, storage).create(source.id, 'No implicit hooks')
    await expect(access(marker)).rejects.toThrow()
  })
  it('refuses cleanup after user changes a new worktree', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Changed')
    await writeFile(join(project.folderPath, 'user.txt'), 'keep me')
    await expect(service.discardFresh(project.id)).rejects.toThrow('cleanup refused')
    expect(await readFile(join(project.folderPath, 'user.txt'), 'utf8')).toBe('keep me')
    expect(await service.list()).toHaveLength(1)
  })
  it('rejects a corrupted cleanup target outside managed storage', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Wrong target')
    db.prepare('UPDATE managed_worktrees SET worktree_root = ? WHERE id = ?').run(root, project.id)
    await expect(service.discardFresh(project.id)).rejects.toThrow('cleanup refused')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('source\n')
  })

  it('records the base it starts from', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const base = await git(root, ['branch', '--show-current'])
    const service = new ManagedWorktreeService(db, storage)
    await service.create(source.id, 'Cards')
    const [worktree] = await service.list()
    expect(worktree).toMatchObject({ branch: null, baseRef: base, owners: [] })
    expect(worktree.status).toEqual({ currentBranch: null, ahead: 0, changedFiles: 0 })
  })

  it('starts several detached worktrees from one base without inventing branch names', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const first = await service.create(source.id, 'Fix cards')
    const second = await service.create(source.id, 'Fix cards')
    expect(first.folderPath).not.toBe(second.folderPath)
    expect(await git(first.folderPath, ['branch', '--show-current'])).toBe('')
    expect(await git(second.folderPath, ['branch', '--show-current'])).toBe('')
    expect((await service.list()).map(({ branch }) => branch)).toEqual([null, null])
  })

  it('reports commits, changes and the chats that use it', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Status')
    addWorktreeChat(db, 'chat-1', project, 'Status chat')
    await commitFile(project.folderPath, 'work.txt', 'work\n')
    await writeFile(join(project.folderPath, 'draft.txt'), 'draft', 'utf8')

    const [worktree] = await service.list()
    expect(worktree.status).toEqual({ currentBranch: null, ahead: 1, changedFiles: 1 })
    expect(worktree.owners).toEqual([
      { kind: 'chat', id: 'chat-1', title: 'Status chat', running: false }
    ])
  })

  it('removes a worktree with its changes, keeps branches made in it, and detaches its chats', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Removed')
    addWorktreeChat(db, 'chat-2', project)
    await git(project.folderPath, ['switch', '-c', 'agent/cards'])
    await commitFile(project.folderPath, 'work.txt', 'work\n')
    await writeFile(join(project.folderPath, 'draft.txt'), 'draft', 'utf8')
    const [worktree] = await service.list()

    markRunning(db, 'chat-2')
    expect(await service.remove(worktree.id)).toEqual({
      removed: false,
      reason: 'An agent is working in it. Stop it first.'
    })
    expect(await readFile(join(project.folderPath, 'draft.txt'), 'utf8')).toBe('draft')

    db.prepare("UPDATE agent_runs SET phase = 'completed' WHERE thread_id = 'chat-2'").run()
    expect(await service.remove(worktree.id)).toEqual({ removed: true })
    await expect(access(project.folderPath)).rejects.toThrow()
    // The agent's branch is the user's to merge or open a pull request from.
    expect(await git(root, ['branch', '--list', 'agent/cards'])).toContain('agent/cards')
    expect(
      db
        .prepare(
          'SELECT project_id, worktree_id, home_workspace_root FROM conversations WHERE id = ?'
        )
        .get('chat-2')
    ).toEqual({ project_id: null, worktree_id: null, home_workspace_root: project.folderPath })
    expect(await service.list()).toEqual([])
  })

  it('removes links inside a worktree without emptying their targets', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'sidekick-shared-install-'))
    try {
      await mkdir(join(shared, 'package'))
      await writeFile(join(shared, 'package', 'index.js'), 'shared', 'utf8')
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage)
      const project = await service.create(source.id, 'Linked')
      await symlink(shared, join(project.folderPath, 'node_modules'), 'junction')
      const [worktree] = await service.list()
      expect((await service.remove(worktree.id)).removed).toBe(true)
      expect(await readFile(join(shared, 'package', 'index.js'), 'utf8')).toBe('shared')
    } finally {
      await rm(shared, { recursive: true, force: true })
    }
  })

  it('sets the least recently used worktree aside and restores it exactly when its chat runs', async () => {
    await commitFile(root, 'gone.txt', 'tracked\n')
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
    const older = await service.create(source.id, 'Older')
    addWorktreeChat(db, 'older-chat', older)
    await git(older.folderPath, ['switch', '-c', 'agent/older'])
    await commitFile(older.folderPath, 'work.txt', 'committed\n')
    await writeFile(join(older.folderPath, 'README.md'), 'edited\n', 'utf8')
    await writeFile(join(older.folderPath, 'new.txt'), 'untracked\n', 'utf8')
    await rm(join(older.folderPath, 'gone.txt'))
    await git(older.folderPath, ['add', 'README.md'])
    const head = await git(older.folderPath, ['rev-parse', 'HEAD'])
    const status = await git(older.folderPath, ['status', '--porcelain', '--untracked-files=all'])

    const newer = await service.create(source.id, 'Newer')
    await service.settled()
    await expect(access(older.folderPath)).rejects.toThrow()
    let rows = await service.list()
    const olderRow = rows.find(({ id }) => id === older.id)!
    expect(olderRow).toMatchObject({ branch: 'agent/older', status: null })
    expect(olderRow.setAsideAt).toEqual(expect.any(Number))
    expect(rows.find(({ id }) => id === newer.id)?.setAsideAt).toBeNull()
    // Git keeps the snapshot reachable while the folder is gone.
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).toContain(olderRow.id)

    await service.prepareConversation('older-chat')
    expect(await git(older.folderPath, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await git(older.folderPath, ['branch', '--show-current'])).toBe('agent/older')
    expect(await readFile(join(older.folderPath, 'README.md'), 'utf8')).toBe('edited\n')
    expect(await readFile(join(older.folderPath, 'new.txt'), 'utf8')).toBe('untracked\n')
    await expect(access(join(older.folderPath, 'gone.txt'))).rejects.toThrow()
    // The same changes, now all unstaged.
    const { stdout: restored } = await execFileAsync(
      'git',
      ['-C', older.folderPath, 'status', '--porcelain', '--untracked-files=all'],
      { windowsHide: true }
    )
    expect(restored).toBe(' M README.md\n D gone.txt\n?? new.txt\n')
    expect(status).toBe('M  README.md\n D gone.txt\n?? new.txt')
    expect(await git(older.folderPath, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).not.toContain(olderRow.id)

    // Using the older one made the newer one the least recently used.
    await service.settled()
    rows = await service.list()
    expect(rows.find(({ id }) => id === older.id)?.setAsideAt).toBeNull()
    expect(rows.find(({ id }) => id === newer.id)?.setAsideAt).toEqual(expect.any(Number))
  })

  it('never sets aside a worktree whose chat is running or pinned', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
    const running = await service.create(source.id, 'Running')
    addWorktreeChat(db, 'running-chat', running)
    markRunning(db, 'running-chat')
    const pinned = await service.create(source.id, 'Pinned')
    addWorktreeChat(db, 'pinned-chat', pinned)
    db.prepare("UPDATE conversations SET is_pinned = 1 WHERE id = 'pinned-chat'").run()
    await service.create(source.id, 'Newest')
    await service.settled()
    await access(running.folderPath)
    await access(pinned.folderPath)
    expect((await service.list()).every(({ setAsideAt }) => setAsideAt === null)).toBe(true)
  })

  it('removes a set-aside worktree and its snapshot', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
    const older = await service.create(source.id, 'Older')
    await writeFile(join(older.folderPath, 'draft.txt'), 'draft', 'utf8')
    await service.create(source.id, 'Newer')
    await service.settled()
    const row = (await service.list()).find(({ id }) => id === older.id)!
    expect(row.setAsideAt).toEqual(expect.any(Number))
    expect(await service.remove(row.id)).toEqual({ removed: true })
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).toBe('')
    expect(await service.list()).toHaveLength(1)
  })

  it('gives a chat with no messages its own worktree, keeping it in its project', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    addChat(db, 'fresh', source.id, 'Fresh idea')
    const result = await service.createForConversation({ conversationId: 'fresh' })
    expect(result.conversation).toMatchObject({
      project_id: source.id,
      worktree_id: result.worktree.id,
      worktree_folder: result.worktree.folderPath
    })
    expect(result.worktree.owners.map(({ id }) => id)).toEqual(['fresh'])
    expect(new ProjectStore(db).getConversationContext('fresh')).toMatchObject({
      projectId: source.id,
      projectName: 'Example',
      workspaceRoot: result.worktree.folderPath,
      worktreeId: result.worktree.id,
      isDetached: false
    })
    await expect(service.createForConversation({ conversationId: 'fresh' })).rejects.toThrow(
      'already works in a worktree'
    )

    addChat(db, 'old', source.id)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('m1', 'old', 'user', 'hi', 1)`
    ).run()
    await expect(service.createForConversation({ conversationId: 'old' })).rejects.toThrow(
      'Fork it into a new worktree'
    )
    expect(await service.list()).toHaveLength(1)
  })

  it('removes an unused clean worktree after its last chat is deleted', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    addChat(db, 'gone', source.id)
    const { worktree } = await service.createForConversation({ conversationId: 'gone' })
    expect(await service.removeIfUnused(worktree.id)).toBeNull()
    db.prepare('DELETE FROM conversations WHERE id = ?').run('gone')
    expect((await service.removeIfUnused(worktree.id))?.removed).toBe(true)
    await expect(access(worktree.folderPath)).rejects.toThrow()
  })

  it("starts a worktree from another worktree's branch, in the same project", async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const parent = await service.create(source.id, 'Parent')
    await giveLegacyBranch(db, parent, 'sidekick/parent')
    await commitFile(parent.folderPath, 'parent.txt', 'parent\n')
    const child = await service.create(source.id, 'Child', { fromWorktreeId: parent.id })
    expect(await readFile(join(child.folderPath, 'parent.txt'), 'utf8')).toBe('parent\n')
    const rows = await service.list()
    expect(rows.find(({ id }) => id === child.id)).toMatchObject({
      sourceProjectId: source.id,
      baseRef: 'sidekick/parent'
    })
  })
})
