import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, join, relative, resolve } from 'path'
import { promisify } from 'util'
import type Database from 'better-sqlite3'
import type { Project } from '../../shared/projects'
import { ProjectStore } from './projectStore'

const execFileAsync = promisify(execFile)
const MAX_MANAGED_WORKTREES = 8

interface ManagedWorktreeRow {
  id: string
  project_id: string
  source_project_id: string
  repository_root: string
  worktree_root: string
  branch: string
  created_at: number
  last_used_at: number
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout.trim()
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

function worktreeSlug(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return `${slug || 'fork'}-${id.slice(0, 8)}`
}

export class ManagedWorktreeService {
  private readonly projects: ProjectStore

  constructor(
    private readonly db: Database.Database,
    private readonly storageRoot: string
  ) {
    this.projects = new ProjectStore(db)
  }

  private rowsOldestFirst(): ManagedWorktreeRow[] {
    return this.db
      .prepare('SELECT * FROM managed_worktrees ORDER BY last_used_at ASC, created_at ASC')
      .all() as ManagedWorktreeRow[]
  }

  private projectIsInUse(projectId: string): boolean {
    const conversations = this.db
      .prepare('SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?')
      .get(projectId) as { count: number }
    const participants = this.db
      .prepare('SELECT COUNT(*) AS count FROM collaboration_participants WHERE project_id = ?')
      .get(projectId) as { count: number }
    return conversations.count > 0 || participants.count > 0
  }

  private async removeIfSafe(row: ManagedWorktreeRow): Promise<boolean> {
    if (this.projectIsInUse(row.project_id)) return false
    try {
      if ((await git(row.worktree_root, ['status', '--porcelain'])).trim()) return false
      if (
        !(await gitSucceeds(row.repository_root, [
          'merge-base',
          '--is-ancestor',
          row.branch,
          'HEAD'
        ]))
      ) {
        return false
      }
      await git(row.repository_root, ['worktree', 'remove', '--force', row.worktree_root])
      await git(row.repository_root, ['branch', '-d', row.branch])
      await fs.rm(row.worktree_root, { recursive: true, force: true })
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(row.project_id)
      this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(row.id)
      return true
    } catch (error) {
      console.warn('[Worktrees] Safe cleanup skipped:', error)
      return false
    }
  }

  private async enforceLimit(): Promise<void> {
    let rows = this.rowsOldestFirst()
    if (rows.length < MAX_MANAGED_WORKTREES) return
    for (const row of rows) {
      if (await this.removeIfSafe(row)) {
        rows = this.rowsOldestFirst()
        if (rows.length < MAX_MANAGED_WORKTREES) return
      }
    }
    throw new Error(
      `The ${MAX_MANAGED_WORKTREES} isolated-worktree limit is reached. Remove or merge an older isolated project before creating another.`
    )
  }

  async create(sourceProjectId: string, conversationTitle: string): Promise<Project> {
    const source = this.projects.get(sourceProjectId)
    if (!source) throw new Error('The source project no longer exists')
    await this.enforceLimit()

    let repositoryRoot: string
    try {
      repositoryRoot = resolve(await git(source.folder_path, ['rev-parse', '--show-toplevel']))
    } catch {
      throw new Error('An isolated fork requires a Git project')
    }

    const sourceSubdirectory = relative(repositoryRoot, resolve(source.folder_path))
    if (sourceSubdirectory.startsWith('..'))
      throw new Error('Project folder is outside its Git root')

    const id = randomUUID()
    const name = worktreeSlug(conversationTitle, id)
    const branch = `sidekick/${name}`
    const worktreeRoot = join(this.storageRoot, sourceProjectId, name)
    const projectFolder = sourceSubdirectory ? join(worktreeRoot, sourceSubdirectory) : worktreeRoot
    await fs.mkdir(join(this.storageRoot, sourceProjectId), { recursive: true })

    try {
      await git(repositoryRoot, ['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD'])
      const project = this.projects.create(projectFolder, `${source.name} · ${basename(name)}`)
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO managed_worktrees
           (id, project_id, source_project_id, repository_root, worktree_root, branch,
            created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, project.id, sourceProjectId, repositoryRoot, worktreeRoot, branch, now, now)
      return project
    } catch (error) {
      await git(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot]).catch(() => '')
      await git(repositoryRoot, ['branch', '-D', branch]).catch(() => '')
      await fs.rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async discardFreshProject(projectId: string): Promise<void> {
    const row = this.db
      .prepare('SELECT * FROM managed_worktrees WHERE project_id = ?')
      .get(projectId) as ManagedWorktreeRow | undefined
    if (!row) return
    await git(row.repository_root, ['worktree', 'remove', '--force', row.worktree_root]).catch(
      () => ''
    )
    await git(row.repository_root, ['branch', '-D', row.branch]).catch(() => '')
    await fs.rm(row.worktree_root, { recursive: true, force: true }).catch(() => undefined)
    this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(row.id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  }
}
