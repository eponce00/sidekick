import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile, readFile, access, chmod } from 'fs/promises'
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
      /^sidekick\/fix-cards-/
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
})
