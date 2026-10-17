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
  folder: string,
  projectId: string,
  branch: string
): Promise<void> {
  await git(folder, ['switch', '-c', branch])
  db.prepare('UPDATE managed_worktrees SET branch = ? WHERE project_id = ?').run(branch, projectId)
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

  it('creates an isolated project detached at the source commit, with no new branch', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const branchesBefore = await git(root, ['branch', '--list'])
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Fix cards')

    expect(project.folder_path.startsWith(storage)).toBe(true)
    // Detached: the base branch stays checked out in the project folder, where it already is.
    expect(await git(project.folder_path, ['branch', '--show-current'])).toBe('')
    expect(await git(project.folder_path, ['rev-parse', 'HEAD'])).toBe(
      await git(root, ['rev-parse', 'HEAD'])
    )
    expect(await git(root, ['branch', '--list'])).toBe(branchesBefore)
    const [worktree] = await service.list()
    expect(worktree.branch).toBeNull()
    expect(worktree.status).toEqual({ currentBranch: null, ahead: 0, changedFiles: 0 })
    expect(worktree.setAsideAt).toBeNull()
    expect(worktree.projectName).toMatch(/^Example · from /)
    expect(await git(root, ['status', '--porcelain'])).toBe('')
    expect(
      db
        .prepare('SELECT source_project_id FROM managed_worktrees WHERE project_id = ?')
        .get(project.id)
    ).toEqual({ source_project_id: source.id })
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
    await service.discardFreshProject(project.id)
    await expect(access(project.folder_path)).rejects.toThrow()
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
    await writeFile(join(project.folder_path, 'user.txt'), 'keep me')
    await expect(service.discardFreshProject(project.id)).rejects.toThrow('cleanup refused')
    expect(await readFile(join(project.folder_path, 'user.txt'), 'utf8')).toBe('keep me')
    expect(new ProjectStore(db).get(project.id)).toBeDefined()
  })
  it('rejects a corrupted cleanup target outside managed storage', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Wrong target')
    db.prepare('UPDATE managed_worktrees SET worktree_root = ? WHERE project_id = ?').run(
      root,
      project.id
    )
    await expect(service.discardFreshProject(project.id)).rejects.toThrow('cleanup refused')
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
    expect(first.folder_path).not.toBe(second.folder_path)
    expect(await git(first.folder_path, ['branch', '--show-current'])).toBe('')
    expect(await git(second.folder_path, ['branch', '--show-current'])).toBe('')
    expect((await service.list()).map(({ branch }) => branch)).toEqual([null, null])
  })

  it('reports commits, changes and the chats that use it', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Status')
    addChat(db, 'chat-1', project.id, 'Status chat')
    await commitFile(project.folder_path, 'work.txt', 'work\n')
    await writeFile(join(project.folder_path, 'draft.txt'), 'draft', 'utf8')

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
    addChat(db, 'chat-2', project.id)
    await git(project.folder_path, ['switch', '-c', 'agent/cards'])
    await commitFile(project.folder_path, 'work.txt', 'work\n')
    await writeFile(join(project.folder_path, 'draft.txt'), 'draft', 'utf8')
    const [worktree] = await service.list()

    markRunning(db, 'chat-2')
    expect(await service.remove(worktree.id)).toEqual({
      removed: false,
      reason: 'An agent is working in it. Stop it first.'
    })
    expect(await readFile(join(project.folder_path, 'draft.txt'), 'utf8')).toBe('draft')

    db.prepare("UPDATE agent_runs SET phase = 'completed' WHERE thread_id = 'chat-2'").run()
    expect(await service.remove(worktree.id)).toEqual({ removed: true })
    await expect(access(project.folder_path)).rejects.toThrow()
    // The agent's branch is the user's to merge or open a pull request from.
    expect(await git(root, ['branch', '--list', 'agent/cards'])).toContain('agent/cards')
    expect(
      db
        .prepare('SELECT project_id, home_workspace_root FROM conversations WHERE id = ?')
        .get('chat-2')
    ).toEqual({ project_id: null, home_workspace_root: project.folder_path })
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
      await symlink(shared, join(project.folder_path, 'node_modules'), 'junction')
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
    addChat(db, 'older-chat', older.id)
    await git(older.folder_path, ['switch', '-c', 'agent/older'])
    await commitFile(older.folder_path, 'work.txt', 'committed\n')
    await writeFile(join(older.folder_path, 'README.md'), 'edited\n', 'utf8')
    await writeFile(join(older.folder_path, 'new.txt'), 'untracked\n', 'utf8')
    await rm(join(older.folder_path, 'gone.txt'))
    await git(older.folder_path, ['add', 'README.md'])
    const head = await git(older.folder_path, ['rev-parse', 'HEAD'])
    const status = await git(older.folder_path, ['status', '--porcelain', '--untracked-files=all'])

    const newer = await service.create(source.id, 'Newer')
    await service.settled()
    await expect(access(older.folder_path)).rejects.toThrow()
    let rows = await service.list()
    const olderRow = rows.find(({ projectId }) => projectId === older.id)!
    expect(olderRow).toMatchObject({ branch: 'agent/older', status: null })
    expect(olderRow.setAsideAt).toEqual(expect.any(Number))
    expect(rows.find(({ projectId }) => projectId === newer.id)?.setAsideAt).toBeNull()
    // Git keeps the snapshot reachable while the folder is gone.
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).toContain(olderRow.id)

    await service.prepareConversation('older-chat')
    expect(await git(older.folder_path, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await git(older.folder_path, ['branch', '--show-current'])).toBe('agent/older')
    expect(await readFile(join(older.folder_path, 'README.md'), 'utf8')).toBe('edited\n')
    expect(await readFile(join(older.folder_path, 'new.txt'), 'utf8')).toBe('untracked\n')
    await expect(access(join(older.folder_path, 'gone.txt'))).rejects.toThrow()
    // The same changes, now all unstaged.
    const { stdout: restored } = await execFileAsync(
      'git',
      ['-C', older.folder_path, 'status', '--porcelain', '--untracked-files=all'],
      { windowsHide: true }
    )
    expect(restored).toBe(' M README.md\n D gone.txt\n?? new.txt\n')
    expect(status).toBe('M  README.md\n D gone.txt\n?? new.txt')
    expect(await git(older.folder_path, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).not.toContain(olderRow.id)

    // Using the older one made the newer one the least recently used.
    await service.settled()
    rows = await service.list()
    expect(rows.find(({ projectId }) => projectId === older.id)?.setAsideAt).toBeNull()
    expect(rows.find(({ projectId }) => projectId === newer.id)?.setAsideAt).toEqual(
      expect.any(Number)
    )
  })

  it('never sets aside a worktree whose chat is running or pinned', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
    const running = await service.create(source.id, 'Running')
    addChat(db, 'running-chat', running.id)
    markRunning(db, 'running-chat')
    const pinned = await service.create(source.id, 'Pinned')
    addChat(db, 'pinned-chat', pinned.id)
    db.prepare("UPDATE conversations SET is_pinned = 1 WHERE id = 'pinned-chat'").run()
    await service.create(source.id, 'Newest')
    await service.settled()
    await access(running.folder_path)
    await access(pinned.folder_path)
    expect((await service.list()).every(({ setAsideAt }) => setAsideAt === null)).toBe(true)
  })

  it('removes a set-aside worktree and its snapshot', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
    const older = await service.create(source.id, 'Older')
    await writeFile(join(older.folder_path, 'draft.txt'), 'draft', 'utf8')
    await service.create(source.id, 'Newer')
    await service.settled()
    const row = (await service.list()).find(({ projectId }) => projectId === older.id)!
    expect(row.setAsideAt).toEqual(expect.any(Number))
    expect(await service.remove(row.id)).toEqual({ removed: true })
    expect(await git(root, ['for-each-ref', 'refs/sidekick/worktrees'])).toBe('')
    expect(await service.list()).toHaveLength(1)
  })

  it('moves a chat with no messages into its own new worktree', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    addChat(db, 'fresh', source.id, 'Fresh idea')
    const result = await service.createForConversation({ conversationId: 'fresh' })
    expect(result.conversation).toMatchObject({
      project_id: result.project.id,
      home_workspace_root: result.project.folder_path
    })
    expect(result.worktree.owners.map(({ id }) => id)).toEqual(['fresh'])
    expect(new ProjectStore(db).getConversationContext('fresh').workspaceRoot).toBe(
      result.project.folder_path
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
    const { project } = await service.createForConversation({ conversationId: 'gone' })
    expect(await service.removeIfUnused(project.id)).toBeNull()
    db.prepare('DELETE FROM conversations WHERE id = ?').run('gone')
    expect((await service.removeIfUnused(project.id))?.removed).toBe(true)
    await expect(access(project.folder_path)).rejects.toThrow()
  })

  it('starts a worktree of a worktree from its branch, stored under the original project', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const parent = await service.create(source.id, 'Parent')
    await giveLegacyBranch(db, parent.folder_path, parent.id, 'sidekick/parent')
    await commitFile(parent.folder_path, 'parent.txt', 'parent\n')
    const child = await service.create(parent.id, 'Child')
    expect(await readFile(join(child.folder_path, 'parent.txt'), 'utf8')).toBe('parent\n')
    const rows = await service.list()
    expect(rows.find(({ projectId }) => projectId === child.id)).toMatchObject({
      sourceProjectId: source.id,
      baseRef: 'sidekick/parent'
    })
  })
})
