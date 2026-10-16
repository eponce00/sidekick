import { execFile } from 'child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile, access, chmod, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ProjectStore } from './projectStore'
import { ManagedWorktreeService, measureDirectory } from './managedWorktreeService'

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

  it('creates an isolated project on a SideKick branch outside the source checkout', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const project = await new ManagedWorktreeService(db, storage).create(source.id, 'Fix cards')

    expect(project.folder_path.startsWith(storage)).toBe(true)
    expect(await git(project.folder_path, ['branch', '--show-current'])).toMatch(
      /^sidekick\/fix-cards$/
    )
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

  it('records the base and uses a chosen branch name', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const base = await git(root, ['branch', '--show-current'])
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Ignored', { branchName: 'feature/cards' })
    expect(await git(project.folder_path, ['branch', '--show-current'])).toBe('feature/cards')
    const [worktree] = await service.list()
    expect(worktree).toMatchObject({ branch: 'feature/cards', baseRef: base, owners: [] })
    expect(worktree.status).toMatchObject({ ahead: 0, behind: 0, changedFiles: 0, merged: true })
    await expect(
      service.create(source.id, 'Again', { branchName: 'feature/cards' })
    ).rejects.toThrow('already exists')
    await expect(service.create(source.id, 'Bad', { branchName: 'bad..name' })).rejects.toThrow(
      'not a valid Git branch name'
    )
  })

  it('gives a suggested branch name a free suffix', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const first = await service.create(source.id, 'Fix cards')
    const second = await service.create(source.id, 'Fix cards')
    expect(await git(first.folder_path, ['branch', '--show-current'])).toBe('sidekick/fix-cards')
    expect(await git(second.folder_path, ['branch', '--show-current'])).toBe('sidekick/fix-cards-2')
  })

  it('reports ahead, behind, changes, owners and why removal is refused', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Status')
    addChat(db, 'chat-1', project.id, 'Status chat')
    await commitFile(project.folder_path, 'work.txt', 'work\n')
    await commitFile(root, 'base.txt', 'base\n')
    await writeFile(join(project.folder_path, 'draft.txt'), 'draft', 'utf8')

    const [worktree] = await service.list()
    expect(worktree.status).toMatchObject({ ahead: 1, behind: 1, changedFiles: 1, merged: false })
    expect(worktree.owners).toEqual([
      { kind: 'chat', id: 'chat-1', title: 'Status chat', running: false }
    ])
    expect(worktree.blockers.map(({ code }) => code)).toEqual(['in-use', 'modified', 'unmerged'])
    expect(await service.remove({ id: worktree.id })).toMatchObject({ removed: false })
    expect(await readFile(join(project.folder_path, 'draft.txt'), 'utf8')).toBe('draft')

    markRunning(db, 'chat-1')
    const forced = await service.remove({ id: worktree.id, force: true })
    expect(forced.removed).toBe(false)
    expect(forced.blockers.find(({ code }) => code === 'running')?.forceable).toBe(false)
  })

  it('force-removes after confirmation, detaches chats and keeps unmerged commits', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Forced')
    addChat(db, 'chat-2', project.id)
    await commitFile(project.folder_path, 'work.txt', 'work\n')
    await writeFile(join(project.folder_path, 'draft.txt'), 'draft', 'utf8')
    const [worktree] = await service.list()

    const result = await service.remove({ id: worktree.id, force: true })
    expect(result).toMatchObject({
      removed: true,
      keptBranch: worktree.branch,
      detachedConversationIds: ['chat-2']
    })
    await expect(access(project.folder_path)).rejects.toThrow()
    expect(await git(root, ['branch', '--list', worktree.branch])).toContain(worktree.branch)
    expect(
      db
        .prepare('SELECT project_id, home_workspace_root FROM conversations WHERE id = ?')
        .get('chat-2')
    ).toEqual({ project_id: null, home_workspace_root: project.folder_path })
    expect(await service.list()).toEqual([])
  })

  it('deletes an unmerged branch only when asked', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Drop')
    await commitFile(project.folder_path, 'work.txt', 'work\n')
    const [worktree] = await service.list()
    const result = await service.remove({ id: worktree.id, force: true, deleteBranch: true })
    expect(result.removed).toBe(true)
    expect(result.keptBranch).toBeUndefined()
    expect(await git(root, ['branch', '--list', worktree.branch])).toBe('')
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
      expect((await service.remove({ id: worktree.id, force: true })).removed).toBe(true)
      expect(await readFile(join(shared, 'package', 'index.js'), 'utf8')).toBe('shared')
    } finally {
      await rm(shared, { recursive: true, force: true })
    }
  })

  it('merges the base into a clean worktree and aborts a conflicting merge', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Sync')
    const [worktree] = await service.list()
    expect((await service.syncWithBase(worktree.id)).status).toBe('up-to-date')

    await commitFile(root, 'base.txt', 'base\n')
    expect((await service.syncWithBase(worktree.id)).status).toBe('merged')
    expect(await readFile(join(project.folder_path, 'base.txt'), 'utf8')).toBe('base\n')

    await commitFile(root, 'README.md', 'from base\n')
    await commitFile(project.folder_path, 'README.md', 'from worktree\n')
    const conflict = await service.syncWithBase(worktree.id)
    expect(conflict).toMatchObject({ status: 'conflict', conflicts: ['README.md'] })
    expect(await git(project.folder_path, ['status', '--porcelain'])).toBe('')
    expect(await readFile(join(project.folder_path, 'README.md'), 'utf8')).toBe('from worktree\n')

    await writeFile(join(project.folder_path, 'draft.txt'), 'draft', 'utf8')
    expect((await service.syncWithBase(worktree.id)).status).toBe('refused')
  })

  it('moves a chat with no messages into its own new worktree', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    addChat(db, 'fresh', source.id, 'Fresh idea')
    const result = await service.createForConversation({
      conversationId: 'fresh',
      branchName: 'sidekick/fresh-idea'
    })
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
    expect((await service.removeIfUnused(project.id))?.removed).toBe(false)
    db.prepare('DELETE FROM conversations WHERE id = ?').run('gone')
    expect((await service.removeIfUnused(project.id))?.removed).toBe(true)
    await expect(access(project.folder_path)).rejects.toThrow()
  })

  it('starts a worktree of a worktree from its branch, stored under the original project', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const parent = await service.create(source.id, 'Parent')
    await commitFile(parent.folder_path, 'parent.txt', 'parent\n')
    const child = await service.create(parent.id, 'Child')
    expect(await readFile(join(child.folder_path, 'parent.txt'), 'utf8')).toBe('parent\n')
    const rows = await service.list()
    expect(rows.find(({ projectId }) => projectId === child.id)).toMatchObject({
      sourceProjectId: source.id,
      baseRef: 'sidekick/parent'
    })
  })

  it('measures disk use without following links', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sidekick-measure-'))
    const outside = await mkdtemp(join(tmpdir(), 'sidekick-measure-outside-'))
    try {
      await writeFile(join(folder, 'a.txt'), '12345', 'utf8')
      await writeFile(join(outside, 'big.txt'), 'x'.repeat(1000), 'utf8')
      await symlink(outside, join(folder, 'link'), 'junction')
      expect(await measureDirectory(folder)).toEqual({ bytes: 5, truncated: false })
      expect((await measureDirectory(folder, { entries: 1, milliseconds: 1000 })).truncated).toBe(
        true
      )
    } finally {
      await rm(folder, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
