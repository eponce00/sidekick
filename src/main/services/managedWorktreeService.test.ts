// Over the 30-second budget on Windows (about 2 minutes): every case adds, sets aside and
// removes real Git worktrees, at some 100 ms a Git command. Each test copies one committed
// template repository instead of building its own, and the git project in vitest.config.ts runs
// this file beside the rest of the suite.
import { execFile } from 'child_process'
import {
  cp,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  access,
  chmod,
  symlink,
  realpath,
  unlink,
  rmdir
} from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, sep } from 'path'
import { promisify } from 'util'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ProjectStore } from './projectStore'
import {
  ManagedWorktreeService,
  siblingWorktreesFolder,
  worktreeFolderName
} from './managedWorktreeService'
import { isPathInside } from '../utils/paths'
import type { ManagedWorktreeSummary } from '../../shared/worktrees'

/** Hex suffixes the next worktree names use, in order, so tests can make names collide. */
const names = vi.hoisted(() => ({ suffixes: [] as string[] }))
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => {
      const forced = names.suffixes.shift()
      return forced ? Buffer.from(forced, 'hex') : actual.randomBytes(size)
    }
  }
})

const execFileAsync = promisify(execFile)
const FOLDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/

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
 * A worktree where SideKick used to put every worktree: its storage, under the source project,
 * with a long name.
 */
async function addLegacyWorktree(
  db: Database.Database,
  storage: string,
  repository: string,
  projectId: string
): Promise<string> {
  const worktreeRoot = join(storage, projectId, 'fix-the-cards-in-the-old-place-1234abcd')
  await mkdir(join(storage, projectId), { recursive: true })
  await git(repository, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD'])
  db.prepare(
    `INSERT INTO managed_worktrees
     (id, source_project_id, repository_root, worktree_root, folder_path, base_ref, created_at,
      last_used_at)
     VALUES ('legacy-worktree', ?, ?, ?, ?, ?, 1, 1)`
  ).run(
    projectId,
    await realpath(repository),
    worktreeRoot,
    worktreeRoot,
    await git(repository, ['rev-parse', 'HEAD'])
  )
  return worktreeRoot
}

/** Removes a link to a folder without touching the folder it leads to. */
async function removeLink(path: string): Promise<void> {
  await unlink(path).catch(() => rmdir(path))
}

async function commitFile(cwd: string, file: string, content: string): Promise<void> {
  await writeFile(join(cwd, file), content, 'utf8')
  await git(cwd, ['add', file])
  await git(cwd, ['-c', 'user.email=t@test.local', '-c', 'user.name=T', 'commit', '-m', file])
}

describe('ManagedWorktreeService', () => {
  let db: Database.Database
  /** A committed repository built once; each test works in a copy of it. */
  let template: string
  let root: string
  let storage: string
  /** Where new worktrees of `root` go: the folder beside it. */
  let sibling: string

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'sidekick-worktree-template-'))
    await git(template, ['init'])
    await git(template, ['config', 'user.email', 'sidekick@test.local'])
    await git(template, ['config', 'user.name', 'SideKick Test'])
    // Compare file contents exactly on Windows too.
    await git(template, ['config', 'core.autocrlf', 'false'])
    await writeFile(join(template, 'README.md'), 'source\n', 'utf8')
    await git(template, ['add', 'README.md'])
    await git(template, ['commit', '-m', 'initial'])
  })

  afterAll(async () => {
    await rm(template, { recursive: true, force: true })
  })

  beforeEach(async () => {
    names.suffixes.length = 0
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    root = await mkdtemp(join(tmpdir(), 'sidekick-worktree-source-'))
    storage = await mkdtemp(join(tmpdir(), 'sidekick-worktree-storage-'))
    await cp(template, root, { recursive: true })
    // As the service spells it: the real path, which may differ from the temporary folder's
    // spelling (a short 8.3 name on Windows, a /private prefix on macOS).
    sibling = siblingWorktreesFolder(await realpath(root))!
  })

  afterEach(async () => {
    db.close()
    // Windows can hold a just-closed Git handle for a moment.
    const removal = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }
    await rm(root, removal)
    await rm(sibling, removal)
    await rm(storage, removal)
  })

  it('creates a worktree on a branch of its own from the source commit, with no new project', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const base = await git(root, ['branch', '--show-current'])
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Fix cards')

    // Beside the repository, with a short name, never inside the checkout or SideKick's storage.
    expect(dirname(project.worktreeRoot)).toBe(sibling)
    expect(basename(project.worktreeRoot)).toMatch(/^fix-cards-[0-9a-f]{6}$/)
    expect(isPathInside(root, project.worktreeRoot)).toBe(false)
    expect(isPathInside(storage, project.worktreeRoot)).toBe(false)
    // Its branch is named after its folder; the base stays checked out in the project folder.
    const branch = `sidekick/${basename(project.worktreeRoot)}`
    expect(await git(project.folderPath, ['branch', '--show-current'])).toBe(branch)
    expect(await git(project.folderPath, ['rev-parse', 'HEAD'])).toBe(
      await git(root, ['rev-parse', 'HEAD'])
    )
    expect(await git(root, ['branch', '--show-current'])).toBe(base)
    const [worktree] = await service.list()
    expect(worktree.branch).toBe(branch)
    expect(worktree.status).toEqual({ currentBranch: branch, ahead: 0, changedFiles: 0 })
    expect(worktree.setAsideAt).toBeNull()
    expect(worktree).toMatchObject({
      sourceProjectId: source.id,
      sourceProjectName: 'Example',
      baseRef: base,
      owners: []
    })
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
  it('discards a fresh worktree only while the user has not changed it, keeping the source', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Fresh')
    await writeFile(join(project.folderPath, 'user.txt'), 'keep me')
    await expect(service.discardFresh(project.id)).rejects.toThrow('cleanup refused')
    expect(await readFile(join(project.folderPath, 'user.txt'), 'utf8')).toBe('keep me')
    expect(await service.list()).toHaveLength(1)

    await rm(join(project.folderPath, 'user.txt'))
    await service.discardFresh(project.id)
    await expect(access(project.folderPath)).rejects.toThrow()
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('source\n')
    // Its branch never held any work, so it goes too.
    expect(await git(root, ['branch', '--list', project.branch!])).toBe('')
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
  it('rejects a corrupted cleanup target outside managed storage', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Wrong target')
    db.prepare('UPDATE managed_worktrees SET worktree_root = ? WHERE id = ?').run(root, project.id)
    await expect(service.discardFresh(project.id)).rejects.toThrow('cleanup refused')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('source\n')
  })

  it('never takes a branch name already in use', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    await git(root, ['branch', 'sidekick/fix-cards-aaaaaa'])
    names.suffixes.push('aaaaaa', 'dddddd')
    const worktree = await service.create(source.id, 'Fix cards')
    expect(basename(worktree.worktreeRoot)).toBe('fix-cards-aaaaaa')
    expect(worktree.branch).toBe('sidekick/fix-cards-aaaaaa-dddddd')

    // A branch named `sidekick` leaves no room for `sidekick/...` branches, and Git refuses it
    // while any of those exist.
    await service.remove(worktree.id)
    await git(root, ['branch', '-D', 'sidekick/fix-cards-aaaaaa'])
    await git(root, ['branch', 'sidekick'])
    names.suffixes.push('eeeeee')
    expect((await service.create(source.id, 'Fix cards')).branch).toBe('sidekick-fix-cards-eeeeee')
  })

  it('reports commits, changes and the chats that use it', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const service = new ManagedWorktreeService(db, storage)
    const project = await service.create(source.id, 'Status')
    addWorktreeChat(db, 'chat-1', project, 'Status chat')
    await commitFile(project.folderPath, 'work.txt', 'work\n')
    await writeFile(join(project.folderPath, 'draft.txt'), 'draft', 'utf8')

    const [worktree] = await service.list()
    expect(worktree.status).toEqual({ currentBranch: project.branch, ahead: 1, changedFiles: 1 })
    expect(worktree.owners).toEqual([
      { kind: 'chat', id: 'chat-1', title: 'Status chat', running: false }
    ])
  })

  it('removes a worktree with its changes, keeps branches with work, and detaches its chats', async () => {
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
    // The agent's branch is the user's to merge or open a pull request from. The one SideKick
    // made never held any work, so it went with the folder.
    expect(await git(root, ['branch', '--list', 'agent/cards'])).toContain('agent/cards')
    expect(await git(root, ['branch', '--list', project.branch!])).toBe('')
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
      worktree: {
        projectFolder: source.folder_path,
        branch: result.worktree.branch,
        base: await git(root, ['branch', '--show-current'])
      },
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
    await commitFile(parent.folderPath, 'parent.txt', 'parent\n')
    const child = await service.create(source.id, 'Child', { fromWorktreeId: parent.id })
    expect(await readFile(join(child.folderPath, 'parent.txt'), 'utf8')).toBe('parent\n')
    const rows = await service.list()
    expect(rows.find(({ id }) => id === child.id)).toMatchObject({
      sourceProjectId: source.id,
      baseRef: parent.branch
    })
    expect(child.branch).toMatch(/^sidekick\/child-[0-9a-f]{6}$/)
  })

  it('keeps its own branch when it holds work, and deletes it once merged', async () => {
    const source = new ProjectStore(db).create(root, 'Example')
    const base = await git(root, ['branch', '--show-current'])
    const service = new ManagedWorktreeService(db, storage)

    const unmerged = await service.create(source.id, 'Unmerged')
    await commitFile(unmerged.folderPath, 'unmerged.txt', 'work\n')
    expect(await service.remove(unmerged.id)).toEqual({ removed: true })
    expect(await git(root, ['show', `${unmerged.branch}:unmerged.txt`])).toBe('work')

    const merged = await service.create(source.id, 'Merged')
    await commitFile(merged.folderPath, 'merged.txt', 'work\n')
    await git(root, ['merge', '--ff-only', merged.branch!])
    expect(await service.remove(merged.id)).toEqual({ removed: true })
    expect(await git(root, ['branch', '--list', merged.branch!])).toBe('')
    expect(await git(root, ['branch', '--show-current'])).toBe(base)
    expect(await readFile(join(root, 'merged.txt'), 'utf8')).toBe('work\n')
  })

  describe('where worktrees go', () => {
    it('names a worktree from a worker handle or a chat title, short and safe', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage)
      addChat(db, 'worker', source.id, 'Write the end-to-end tests for the API contract')
      db.prepare("UPDATE conversations SET session_handle = 'api-tests' WHERE id = 'worker'").run()
      const { worktree } = await service.createForConversation({ conversationId: 'worker' })
      expect(basename(worktree.worktreeRoot)).toMatch(/^api-tests-[0-9a-f]{6}$/)

      const created = await service.create(
        source.id,
        'Fix the login page redirect loop on Windows and macOS'
      )
      expect(dirname(created.worktreeRoot)).toBe(sibling)
      // The whole path is the repository's plus at most 38 characters.
      const repository = join(dirname(sibling), basename(sibling, '.worktrees'))
      expect(created.worktreeRoot.length - repository.length).toBeLessThanOrEqual(38)

      for (const title of [
        'Fix the login page redirect loop on Windows and macOS',
        '../../escape',
        'C:\\Windows\\System32',
        '.git',
        'CON',
        '名前のないチャット'
      ]) {
        const name = worktreeFolderName(title)
        expect(name).toMatch(FOLDER_NAME)
        expect(name.length).toBeLessThanOrEqual(27)
      }
    })

    it('never takes a folder name already in use, whoever made it', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage)
      await mkdir(join(sibling, 'fix-cards-cccccc'), { recursive: true })
      await writeFile(join(sibling, 'fix-cards-cccccc', 'mine.txt'), 'mine', 'utf8')
      names.suffixes.push('aaaaaa', 'aaaaaa', 'cccccc', 'bbbbbb')

      const first = await service.create(source.id, 'Fix cards')
      const second = await service.create(source.id, 'Fix cards')
      expect(basename(first.worktreeRoot)).toBe('fix-cards-aaaaaa')
      expect(basename(second.worktreeRoot)).toBe('fix-cards-bbbbbb')
      expect(await readFile(join(sibling, 'fix-cards-cccccc', 'mine.txt'), 'utf8')).toBe('mine')
    })

    it("uses SideKick's storage when the place beside the repository is not a plain folder", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const elsewhere = await mkdtemp(join(tmpdir(), 'sidekick-worktree-elsewhere-'))
      try {
        const source = new ProjectStore(db).create(root, 'Example')
        const service = new ManagedWorktreeService(db, storage)

        await writeFile(sibling, 'not a folder', 'utf8')
        const besideFile = await service.create(source.id, 'Fix cards')
        expect(dirname(besideFile.worktreeRoot)).toBe(join(storage, source.id))
        expect(basename(besideFile.worktreeRoot)).toMatch(/^fix-cards-[0-9a-f]{6}$/)
        expect(await readFile(sibling, 'utf8')).toBe('not a folder')
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("SideKick's storage"),
          expect.any(String)
        )

        // A link could lead anywhere, so it is never followed.
        await rm(sibling)
        await symlink(elsewhere, sibling, 'junction')
        const besideLink = await service.create(source.id, 'Fix cards')
        expect(dirname(besideLink.worktreeRoot)).toBe(join(storage, source.id))
        expect(await readdir(elsewhere)).toEqual([])

        // Removal works there as before, and the link stays.
        expect((await service.remove(besideLink.id)).removed).toBe(true)
        await expect(access(besideLink.worktreeRoot)).rejects.toThrow()
        await access(sibling)
      } finally {
        await removeLink(sibling).catch(() => undefined)
        await rm(elsewhere, { recursive: true, force: true })
        warn.mockRestore()
      }
    })

    it('keeps worktrees of a repository inside another repository out of the outer one', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const inner = join(root, 'packages', 'inner')
        await mkdir(inner, { recursive: true })
        await git(inner, ['init'])
        await commitFile(inner, 'inner.txt', 'inner\n')
        const source = new ProjectStore(db).create(inner, 'Inner')
        const worktree = await new ManagedWorktreeService(db, storage).create(source.id, 'Fix')
        expect(dirname(worktree.worktreeRoot)).toBe(join(storage, source.id))
        await expect(access(join(root, 'packages', 'inner.worktrees'))).rejects.toThrow()
      } finally {
        warn.mockRestore()
      }
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'uses storage when the folder holding the repository cannot be written',
      async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const parent = await mkdtemp(join(tmpdir(), 'sidekick-worktree-readonly-'))
        try {
          const repository = join(parent, 'repo')
          await mkdir(repository)
          await git(repository, ['init'])
          await commitFile(repository, 'a.txt', 'a\n')
          await chmod(parent, 0o555)
          const source = new ProjectStore(db).create(repository, 'Read-only parent')
          const worktree = await new ManagedWorktreeService(db, storage).create(source.id, 'Fix')
          expect(dirname(worktree.worktreeRoot)).toBe(join(storage, source.id))
        } finally {
          await chmod(parent, 0o755)
          await rm(parent, { recursive: true, force: true })
          warn.mockRestore()
        }
      }
    )

    it('removes the folder beside the repository with its last worktree, and only then', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage)
      const first = await service.create(source.id, 'First')
      const second = await service.create(source.id, 'Second')

      expect(await service.remove(first.id)).toEqual({ removed: true })
      expect(await readdir(sibling)).toEqual([basename(second.worktreeRoot)])
      expect(await service.remove(second.id)).toEqual({ removed: true })
      await expect(access(sibling)).rejects.toThrow()
      expect(await git(root, ['worktree', 'list', '--porcelain'])).not.toContain('.worktrees')

      // Anything else in it keeps it.
      const third = await service.create(source.id, 'Third')
      await writeFile(join(sibling, 'notes.txt'), 'mine', 'utf8')
      expect(await service.remove(third.id)).toEqual({ removed: true })
      expect(await readdir(sibling)).toEqual(['notes.txt'])
    })

    it('brings a set-aside worktree back beside the repository, remaking the folder', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
      const older = await service.create(source.id, 'Older')
      addWorktreeChat(db, 'older-chat', older)
      await writeFile(join(older.folderPath, 'draft.txt'), 'draft', 'utf8')
      const newer = await service.create(source.id, 'Newer')
      await service.settled()
      await expect(access(older.worktreeRoot)).rejects.toThrow()
      expect(await service.remove(newer.id)).toEqual({ removed: true })
      await expect(access(sibling)).rejects.toThrow()

      await service.prepareConversation('older-chat')
      expect(await readFile(join(older.worktreeRoot, 'draft.txt'), 'utf8')).toBe('draft')
      expect(dirname(older.worktreeRoot)).toBe(sibling)
    })

    it('keeps a worktree made in the old place working there, through set-aside and removal', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
      const legacyRoot = await addLegacyWorktree(db, storage, root, source.id)
      addChat(db, 'legacy-chat', source.id)
      db.prepare(
        "UPDATE conversations SET worktree_id = 'legacy-worktree' WHERE id = 'legacy-chat'"
      ).run()
      await writeFile(join(legacyRoot, 'draft.txt'), 'draft', 'utf8')
      const [listed] = await service.list()
      expect(listed).toMatchObject({ worktreeRoot: legacyRoot, status: { changedFiles: 1 } })

      // A newer worktree goes beside the repository and sets the old one aside...
      const newer = await service.create(source.id, 'Newer')
      expect(dirname(newer.worktreeRoot)).toBe(sibling)
      await service.settled()
      await expect(access(legacyRoot)).rejects.toThrow()
      // ...and its chat brings it back where it was, not beside the repository.
      await service.prepareConversation('legacy-chat')
      expect(await readFile(join(legacyRoot, 'draft.txt'), 'utf8')).toBe('draft')
      await service.settled()

      expect(await service.remove('legacy-worktree')).toEqual({ removed: true })
      await expect(access(legacyRoot)).rejects.toThrow()
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('source\n')
    })

    it('acts only on folders directly inside the places it makes worktrees', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage)
      const outside = await mkdtemp(join(tmpdir(), 'sidekick-user-worktree-'))
      try {
        const userWorktree = join(outside, 'mine-123456')
        const nested = join(sibling, 'deeper', 'mine-123456')
        const hidden = join(sibling, '.hidden-123456')
        await mkdir(join(sibling, 'deeper'), { recursive: true })
        for (const path of [userWorktree, nested, hidden])
          await git(root, ['worktree', 'add', '--detach', path, 'HEAD'])

        const targets = [
          root,
          sibling,
          userWorktree,
          nested,
          hidden,
          // Unnormalized, so it leads back to the repository from inside the worktrees folder. It
          // passes through a folder that exists, since POSIX resolves `..` on the real folders.
          `${sibling}${sep}deeper${sep}..${sep}..${sep}${basename(sibling, '.worktrees')}`
        ]
        // A refused removal keeps the record, so one worktree serves every target.
        const worktree = await service.create(source.id, 'Target')
        for (const target of targets) {
          db.prepare('UPDATE managed_worktrees SET worktree_root = ? WHERE id = ?').run(
            target,
            worktree.id
          )
          expect(await service.remove(worktree.id)).toMatchObject({ removed: false })
        }
        for (const path of [root, userWorktree, nested, hidden]) await access(path)
        expect(await readFile(join(userWorktree, 'README.md'), 'utf8')).toBe('source\n')
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('never restores a set-aside worktree outside the places it makes worktrees', async () => {
      const source = new ProjectStore(db).create(root, 'Example')
      const service = new ManagedWorktreeService(db, storage, { maxOnDisk: 1 })
      const older = await service.create(source.id, 'Older')
      addWorktreeChat(db, 'older-chat', older)
      await service.create(source.id, 'Newer')
      await service.settled()
      for (const escape of [
        join(root, 'escape-123456'),
        join(sibling, '..', 'escape-123456'),
        join(sibling, '.escape-123456')
      ]) {
        db.prepare('UPDATE managed_worktrees SET worktree_root = ? WHERE id = ?').run(
          escape,
          older.id
        )
        await expect(service.prepareConversation('older-chat')).rejects.toThrow(
          'outside the folders'
        )
        await expect(access(escape)).rejects.toThrow()
      }
    })
  })
})
