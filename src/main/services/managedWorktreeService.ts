import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import type Database from 'better-sqlite3'
import type { Project, ProjectConversation } from '../../shared/projects'
import {
  suggestWorktreeBranch,
  worktreeBranchProblem,
  worktreeSlug,
  type CreateConversationWorktreeInput,
  type CreateConversationWorktreeResult,
  type ManagedWorktreeDiskUsage,
  type ManagedWorktreeGitStatus,
  type ManagedWorktreeOwner,
  type ManagedWorktreeSummary,
  type RemoveManagedWorktreeInput,
  type RemoveManagedWorktreeResult,
  type SyncManagedWorktreeResult,
  type WorktreeBranchOptions,
  type WorktreeRemovalBlocker
} from '../../shared/worktrees'
import { ProjectStore } from './projectStore'
import { shellChildEnvironment } from './commandService'

const execFileAsync = promisify(execFile)
// Codex keeps 15 and Cursor 25; every chat can now have one, so 8 was too tight.
const MAX_MANAGED_WORKTREES = 20
const DISK_WALK_ENTRY_LIMIT = 200_000
const DISK_WALK_TIME_LIMIT_MS = 4_000

interface ManagedWorktreeRow {
  id: string
  project_id: string
  source_project_id: string
  repository_root: string
  worktree_root: string
  branch: string
  base_ref: string | null
  created_at: number
  last_used_at: number
}

interface Assessment {
  row: ManagedWorktreeRow
  owners: ManagedWorktreeOwner[]
  status: ManagedWorktreeGitStatus | null
  blockers: WorktreeRemovalBlocker[]
  /** The canonical worktree path, set only when it is provably SideKick's. */
  managedTarget: string | null
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    {
      windowsHide: true,
      env: shellChildEnvironment(process.env, cwd, cwd),
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    }
  )
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

function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path)
    return process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved
  }
  return normalize(left) === normalize(right)
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr: unknown }).stderr ?? '').trim()
    if (stderr) return stderr.split('\n').slice(-3).join(' ')
  }
  return error instanceof Error ? error.message : String(error)
}

/** A branch or commit given by the user, never an option Git could misread. */
function validRef(ref: string): boolean {
  return /^[A-Za-z0-9._/@^~-]{1,200}$/.test(ref) && !ref.startsWith('-')
}

const blocker = (
  code: WorktreeRemovalBlocker['code'],
  message: string,
  forceable: boolean
): WorktreeRemovalBlocker => ({ code, message, forceable })

/**
 * Sums file sizes without following links, stopping at a file or time budget so a worktree
 * holding a huge dependency folder cannot stall the list.
 */
export async function measureDirectory(
  root: string,
  limits = { entries: DISK_WALK_ENTRY_LIMIT, milliseconds: DISK_WALK_TIME_LIMIT_MS }
): Promise<{ bytes: number; truncated: boolean }> {
  const deadline = Date.now() + limits.milliseconds
  let bytes = 0
  let entries = 0
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    let handle: Awaited<ReturnType<typeof fs.opendir>>
    try {
      handle = await fs.opendir(directory)
    } catch {
      continue
    }
    for await (const entry of handle) {
      // Leaving the loop early closes the handle.
      if (++entries > limits.entries || Date.now() > deadline) return { bytes, truncated: true }
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        bytes += await fs
          .lstat(path)
          .then((stat) => stat.size)
          .catch(() => 0)
      }
    }
  }
  return { bytes, truncated: false }
}

/**
 * Finds links inside a worktree (a `node_modules` junction to a shared install, for example).
 * They are removed as links before Git deletes the folder, so a target is never emptied.
 */
async function findLinks(root: string): Promise<string[]> {
  const links: string[] = []
  const pending = [root]
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()!
    let children: import('fs').Dirent[]
    try {
      children = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of children) {
      if (++entries > DISK_WALK_ENTRY_LIMIT)
        throw new Error('The worktree is too large to check for links safely')
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) links.push(path)
      else if (entry.isDirectory()) pending.push(path)
    }
  }
  return links
}

async function unlinkWithoutFollowing(path: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isSymbolicLink()) return
  try {
    await fs.unlink(path)
  } catch {
    // A Windows directory junction or directory symlink is removed as an empty directory entry.
    await fs.rmdir(path)
  }
}

export class ManagedWorktreeService {
  private readonly projects: ProjectStore
  private readonly busy = new Set<string>()

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

  private row(id: string): ManagedWorktreeRow {
    const row = this.db.prepare('SELECT * FROM managed_worktrees WHERE id = ?').get(id) as
      | ManagedWorktreeRow
      | undefined
    if (!row) throw new Error('This worktree is no longer managed by SideKick')
    return row
  }

  private rowForProject(projectId: string): ManagedWorktreeRow | undefined {
    return this.db
      .prepare('SELECT * FROM managed_worktrees WHERE project_id = ?')
      .get(projectId) as ManagedWorktreeRow | undefined
  }

  branchForProject(projectId: string): string | null {
    return this.rowForProject(projectId)?.branch ?? null
  }

  isManagedProject(projectId: string): boolean {
    return Boolean(this.rowForProject(projectId))
  }

  private owners(projectId: string): ManagedWorktreeOwner[] {
    const chats = this.db
      .prepare('SELECT id, title FROM conversations WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as Array<{ id: string; title: string }>
    return chats.map(({ id, title }) => ({
      kind: 'chat' as const,
      id,
      title,
      running: this.projects.hasActiveRun(id)
    }))
  }

  /** The canonical worktree folder, only when it has exactly the shape SideKick creates. */
  private async managedTarget(row: ManagedWorktreeRow): Promise<string | null> {
    try {
      const [storage, target] = await Promise.all([
        fs.realpath(this.storageRoot),
        fs.realpath(row.worktree_root)
      ])
      const child = relative(storage, target)
      if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return null
      const parts = child.split(sep)
      if (parts.length !== 2 || parts[0] !== row.source_project_id) return null
      const listed = (await git(row.repository_root, ['worktree', 'list', '--porcelain']))
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
      const registered = await Promise.all(
        listed.map((path) =>
          fs
            .realpath(path)
            .then((real) => samePath(real, target))
            .catch(() => false)
        )
      )
      return registered.some(Boolean) ? target : null
    } catch {
      return null
    }
  }

  private async gitStatus(
    row: ManagedWorktreeRow,
    target: string
  ): Promise<ManagedWorktreeGitStatus | null> {
    try {
      const [currentBranch, porcelain] = await Promise.all([
        git(target, ['branch', '--show-current']),
        git(target, ['status', '--porcelain'])
      ])
      const base = row.base_ref ?? 'HEAD'
      let ahead: number | null = null
      let behind: number | null = null
      try {
        const counts = await git(row.repository_root, [
          'rev-list',
          '--left-right',
          '--count',
          `${base}...${row.branch}`
        ])
        const [left, right] = counts.split(/\s+/).map(Number)
        behind = Number.isFinite(left) ? left : null
        ahead = Number.isFinite(right) ? right : null
      } catch {
        // A deleted base still lets the rest of the status load.
      }
      const merged =
        (await gitSucceeds(row.repository_root, [
          'merge-base',
          '--is-ancestor',
          row.branch,
          base
        ])) ||
        (base !== 'HEAD' &&
          (await gitSucceeds(row.repository_root, [
            'merge-base',
            '--is-ancestor',
            row.branch,
            'HEAD'
          ])))
      return {
        currentBranch: currentBranch || null,
        ahead,
        behind,
        changedFiles: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
        merged
      }
    } catch {
      return null
    }
  }

  private async assess(row: ManagedWorktreeRow): Promise<Assessment> {
    const owners = this.owners(row.project_id)
    const blockers: WorktreeRemovalBlocker[] = []
    const running = owners.filter(({ running }) => running)
    if (running.length)
      blockers.push(
        blocker(
          'running',
          `An agent is working in it (${running.map(({ title }) => `“${title}”`).join(', ')}). Stop it first.`,
          false
        )
      )
    const exists = await fs
      .stat(row.worktree_root)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    if (!exists) {
      blockers.push(
        blocker(
          'missing',
          'The folder no longer exists. Removing forgets it and keeps the branch.',
          true
        )
      )
      return { row, owners, status: null, blockers, managedTarget: null }
    }
    const managedTarget = await this.managedTarget(row)
    if (!managedTarget) {
      blockers.push(
        blocker(
          'unmanaged',
          'SideKick cannot prove it created this folder, so it will not delete it. Remove it with Git yourself.',
          false
        )
      )
      return { row, owners, status: null, blockers, managedTarget: null }
    }
    const status = await this.gitStatus(row, managedTarget)
    if (!status) {
      blockers.push(blocker('unmanaged', 'Git could not read this worktree.', false))
      return { row, owners, status, blockers, managedTarget: null }
    }
    if (status.currentBranch !== row.branch)
      blockers.push(
        blocker(
          'unmanaged',
          `It is on ${status.currentBranch ?? 'a detached commit'} instead of ${row.branch}. Switch back or remove it with Git yourself.`,
          false
        )
      )
    const idleOwners = owners.filter(({ running }) => !running)
    if (idleOwners.length)
      blockers.push(
        blocker(
          'in-use',
          `${idleOwners.length === 1 ? 'A chat uses' : `${idleOwners.length} chats use`} it. Forced removal keeps ${idleOwners.length === 1 ? 'that chat' : 'them'} as detached chats.`,
          true
        )
      )
    if (status.changedFiles)
      blockers.push(
        blocker(
          'modified',
          `${status.changedFiles} uncommitted ${status.changedFiles === 1 ? 'change' : 'changes'} would be lost.`,
          true
        )
      )
    if (!status.merged)
      blockers.push(
        blocker(
          'unmerged',
          `${row.branch} has ${status.ahead ?? 'some'} ${status.ahead === 1 ? 'commit' : 'commits'} that ${row.base_ref ?? 'the source checkout'} does not. The branch is kept unless you also delete it.`,
          true
        )
      )
    return { row, owners, status, blockers, managedTarget }
  }

  private summary(assessment: Assessment): ManagedWorktreeSummary {
    const { row } = assessment
    const project = this.projects.get(row.project_id)
    const source = this.projects.get(row.source_project_id)
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: project?.name ?? basename(row.worktree_root),
      folderPath: project?.folder_path ?? row.worktree_root,
      worktreeRoot: row.worktree_root,
      sourceProjectId: row.source_project_id,
      sourceProjectName: source?.name ?? null,
      branch: row.branch,
      baseRef: row.base_ref,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      owners: assessment.owners,
      status: assessment.status,
      blockers: assessment.blockers
    }
  }

  async list(): Promise<ManagedWorktreeSummary[]> {
    const rows = this.rowsOldestFirst().reverse()
    const assessments = await Promise.all(rows.map((row) => this.assess(row)))
    return assessments.map((assessment) => this.summary(assessment))
  }

  async get(id: string): Promise<ManagedWorktreeSummary> {
    return this.summary(await this.assess(this.row(id)))
  }

  async diskUsage(id: string): Promise<ManagedWorktreeDiskUsage> {
    const row = this.row(id)
    return { id, ...(await measureDirectory(row.worktree_root)) }
  }

  /** Branches a new worktree can start from, for the project a chat is in. */
  async branchOptions(projectId: string): Promise<WorktreeBranchOptions> {
    const managed = this.rowForProject(projectId)
    const project = this.projects.get(managed?.source_project_id ?? projectId)
    const empty = {
      branches: [],
      currentBranch: null,
      isGitRepository: false,
      isManagedWorktree: Boolean(managed)
    }
    if (!project) return empty
    try {
      await git(project.folder_path, ['rev-parse', '--show-toplevel'])
    } catch {
      return empty
    }
    const currentBranch =
      (await git(project.folder_path, ['branch', '--show-current']).catch(() => '')) || null
    const branches = (
      await git(project.folder_path, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/heads'
      ]).catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
    return {
      branches: currentBranch
        ? [currentBranch, ...branches.filter((branch) => branch !== currentBranch)]
        : branches,
      currentBranch,
      isGitRepository: true,
      isManagedWorktree: Boolean(managed)
    }
  }

  private async removeIfSafe(row: ManagedWorktreeRow): Promise<boolean> {
    try {
      const result = await this.removeRow(row, {})
      return result.removed
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
      `The ${MAX_MANAGED_WORKTREES}-worktree limit is reached. Remove or merge older worktrees in Manage worktrees before creating another.`
    )
  }

  private async branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
    return gitSucceeds(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  }

  /** A name the user typed must be free; a suggested one gets a numeric suffix instead. */
  private async resolveBranchName(
    repositoryRoot: string,
    requested: string,
    suggested: boolean
  ): Promise<string> {
    const problem = worktreeBranchProblem(requested)
    if (problem) throw new Error(problem)
    const base = requested.trim()
    if (!(await gitSucceeds(repositoryRoot, ['check-ref-format', '--branch', base])))
      throw new Error('That is not a valid Git branch name')
    if (!(await this.branchExists(repositoryRoot, base))) return base
    if (!suggested) throw new Error(`A branch named ${base} already exists`)
    for (let suffix = 2; suffix < 100; suffix++) {
      const candidate = `${base}-${suffix}`
      if (!(await this.branchExists(repositoryRoot, candidate))) return candidate
    }
    throw new Error(`Could not find a free branch name like ${base}`)
  }

  /**
   * Creates a SideKick worktree for a project. A project that is itself a SideKick worktree
   * starts its new worktree from its own branch but is stored under its source project.
   */
  async create(
    sourceProjectId: string,
    conversationTitle: string,
    options: { branchName?: string; baseRef?: string } = {}
  ): Promise<Project> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sourceProjectId))
      throw new Error('Invalid source project identity')
    const parentWorktree = this.rowForProject(sourceProjectId)
    const requestedSource = this.projects.get(sourceProjectId)
    if (!requestedSource) throw new Error('The source project no longer exists')
    const rootProjectId = parentWorktree?.source_project_id ?? sourceProjectId
    const source = this.projects.get(rootProjectId)
    if (!source) throw new Error('The source project no longer exists')
    if (options.baseRef !== undefined && !validRef(options.baseRef))
      throw new Error('That base is not a valid branch or commit')
    await this.enforceLimit()

    let repositoryRoot: string
    try {
      repositoryRoot = await fs.realpath(
        resolve(await git(source.folder_path, ['rev-parse', '--show-toplevel']))
      )
    } catch {
      throw new Error('A worktree requires a Git project')
    }

    const sourceFolder = await fs.realpath(resolve(source.folder_path))
    const sourceSubdirectory = relative(repositoryRoot, sourceFolder)
    if (
      isAbsolute(sourceSubdirectory) ||
      sourceSubdirectory === '..' ||
      sourceSubdirectory.startsWith(`..${sep}`)
    )
      throw new Error('Project folder is outside its Git root')

    // The base is what the chat sees as "where my work came from": a branch when there is one.
    const startFrom = requestedSource.folder_path
    let baseRef = options.baseRef
    if (baseRef) {
      if (
        !(await gitSucceeds(repositoryRoot, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${baseRef}^{commit}`
        ]))
      )
        throw new Error(`There is no branch or commit named ${baseRef}`)
    } else {
      baseRef =
        (await git(startFrom, ['branch', '--show-current']).catch(() => '')) ||
        (await git(startFrom, ['rev-parse', 'HEAD']))
    }

    const id = randomUUID()
    const branch = await this.resolveBranchName(
      repositoryRoot,
      options.branchName ?? suggestWorktreeBranch(conversationTitle),
      options.branchName === undefined
    )
    const name = `${worktreeSlug(branch.split('/').at(-1) ?? branch)}-${id.slice(0, 8)}`
    const worktreeRoot = join(this.storageRoot, rootProjectId, name)
    const projectFolder = sourceSubdirectory ? join(worktreeRoot, sourceSubdirectory) : worktreeRoot
    await fs.mkdir(join(this.storageRoot, rootProjectId), { recursive: true })
    const [canonicalStorage, canonicalParent] = await Promise.all([
      fs.realpath(this.storageRoot),
      fs.realpath(join(this.storageRoot, rootProjectId))
    ])
    const parentChild = relative(canonicalStorage, canonicalParent)
    if (
      !parentChild ||
      parentChild === '..' ||
      parentChild.startsWith(`..${sep}`) ||
      isAbsolute(parentChild)
    )
      throw new Error('Managed worktree parent escapes storage')
    let created = false

    try {
      await git(repositoryRoot, ['worktree', 'add', '-b', branch, worktreeRoot, baseRef])
      created = true
      const project = this.projects.create(projectFolder, `${source.name} · ${branch}`)
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO managed_worktrees
           (id, project_id, source_project_id, repository_root, worktree_root, branch, base_ref,
            created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, project.id, rootProjectId, repositoryRoot, worktreeRoot, branch, baseRef, now, now)
      return project
    } catch (error) {
      // Never delete an unrelated pre-existing branch or changed checkout after
      // an incomplete setup. A cleanup failure leaves recoverable Git state.
      if (created) {
        try {
          await git(repositoryRoot, ['worktree', 'remove', worktreeRoot])
          await git(repositoryRoot, ['branch', '-d', branch])
        } catch {
          /* Preserve files and refs for manual recovery. */
        }
      }
      throw error
    }
  }

  /**
   * Gives a chat that has not started yet its own worktree and moves it there. The entry point
   * for "Work in: new worktree" and for chats another agent starts.
   */
  async createForConversation(
    input: CreateConversationWorktreeInput
  ): Promise<CreateConversationWorktreeResult> {
    const conversation = this.db
      .prepare('SELECT id, title, project_id FROM conversations WHERE id = ?')
      .get(input.conversationId) as
      | Pick<ProjectConversation, 'id' | 'title' | 'project_id'>
      | undefined
    if (!conversation) throw new Error('Conversation not found')
    if (!conversation.project_id) throw new Error('Only a chat in a project can use a worktree')
    if (
      this.db
        .prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1')
        .get(conversation.id)
    )
      throw new Error('This chat already has messages. Fork it into a new worktree instead.')
    const project = await this.create(conversation.project_id, conversation.title, {
      branchName: input.branchName,
      baseRef: input.baseRef
    })
    try {
      const moved = this.projects.rehomeFreshConversation(conversation.id, project.id)
      const row = this.rowForProject(project.id)!
      return { project, conversation: moved, worktree: await this.get(row.id) }
    } catch (error) {
      await this.discardFreshProject(project.id).catch(() => undefined)
      throw error
    }
  }

  async discardFreshProject(projectId: string): Promise<void> {
    const row = this.rowForProject(projectId)
    if (!row) return
    if (!(await this.removeIfSafe(row)))
      throw new Error(
        'Worktree cleanup refused: preserve modified, in-use, unmerged, or out-of-storage work for manual recovery'
      )
  }

  /**
   * Removes a worktree whose last chat was deleted, when nothing would be lost. Anything else stays
   * in the worktree list with its reason.
   */
  async removeIfUnused(projectId: string): Promise<RemoveManagedWorktreeResult | null> {
    const row = this.rowForProject(projectId)
    if (!row) return null
    try {
      return await this.removeRow(row, {})
    } catch (error) {
      console.warn('[Worktrees] Automatic cleanup skipped:', error)
      return null
    }
  }

  async remove(input: RemoveManagedWorktreeInput): Promise<RemoveManagedWorktreeResult> {
    return this.removeRow(this.row(input.id), input)
  }

  private async removeRow(
    row: ManagedWorktreeRow,
    options: { force?: boolean; deleteBranch?: boolean }
  ): Promise<RemoveManagedWorktreeResult> {
    if (this.busy.has(row.id)) throw new Error('This worktree is already being changed')
    this.busy.add(row.id)
    try {
      const assessment = await this.assess(row)
      const hard = assessment.blockers.filter(({ forceable }) => !forceable)
      if (hard.length || (!options.force && assessment.blockers.length))
        return { removed: false, blockers: assessment.blockers }

      const missing = assessment.blockers.some(({ code }) => code === 'missing')
      const target = assessment.managedTarget
      // Recheck at the last moment: a chat may have started while Git was answering.
      if (this.owners(row.project_id).some(({ running }) => running))
        return { removed: false, blockers: (await this.assess(row)).blockers }

      const detachedConversationIds = assessment.owners
        .filter(({ kind }) => kind === 'chat')
        .map(({ id }) => id)

      if (missing) {
        await git(row.repository_root, ['worktree', 'prune'])
      } else if (target) {
        if (options.force) {
          for (const link of await findLinks(target)) await unlinkWithoutFollowing(link)
        }
        // Git rechecks cleanliness at removal time, closing the status/remove race.
        await git(row.repository_root, [
          'worktree',
          'remove',
          ...(options.force ? ['--force'] : []),
          target
        ])
      }

      let keptBranch: string | undefined
      const merged = assessment.status?.merged ?? false
      if (merged) {
        await git(row.repository_root, ['branch', '-d', row.branch]).catch(() => {
          keptBranch = row.branch
        })
      } else if (options.force && options.deleteBranch && !missing) {
        await git(row.repository_root, ['branch', '-D', row.branch])
      } else {
        keptBranch = row.branch
      }

      // The files are gone; chats that used them stay as detached chats with their history.
      this.db.transaction(() => {
        if (this.projects.get(row.project_id)) this.projects.remove(row.project_id)
        this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(row.id)
      })()
      return {
        removed: true,
        blockers: [],
        ...(keptBranch ? { keptBranch } : {}),
        ...(detachedConversationIds.length ? { detachedConversationIds } : {})
      }
    } finally {
      this.busy.delete(row.id)
    }
  }

  /**
   * Merges the base into a clean, idle worktree. A conflict is aborted at once, so the worktree is
   * never left half-merged; the user resolves it themselves or asks the agent to.
   */
  async syncWithBase(id: string): Promise<SyncManagedWorktreeResult> {
    const row = this.row(id)
    if (this.busy.has(row.id)) return { status: 'refused', message: 'This worktree is busy' }
    this.busy.add(row.id)
    try {
      const assessment = await this.assess(row)
      const refusal = assessment.blockers.find(({ code }) =>
        ['running', 'missing', 'unmanaged', 'modified'].includes(code)
      )
      if (refusal) {
        return {
          status: 'refused',
          message:
            refusal.code === 'modified'
              ? 'Commit or discard the uncommitted changes before syncing.'
              : refusal.message
        }
      }
      const target = assessment.managedTarget!
      const base =
        row.base_ref ||
        (await git(row.repository_root, ['branch', '--show-current']).catch(() => ''))
      if (!base) return { status: 'refused', message: 'This worktree has no base to sync with' }
      if (assessment.status?.behind === 0)
        return { status: 'up-to-date', message: `Already up to date with ${base}.` }
      try {
        await git(target, ['merge', '--no-edit', base])
        return { status: 'merged', message: `Merged ${base} into ${row.branch}.` }
      } catch (error) {
        const conflicts = (
          await git(target, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
        )
          .split('\n')
          .filter(Boolean)
        const merging = await gitSucceeds(target, [
          'rev-parse',
          '--verify',
          '--quiet',
          'MERGE_HEAD'
        ])
        if (merging) await git(target, ['merge', '--abort'])
        if (conflicts.length)
          return {
            status: 'conflict',
            message: `Merging ${base} conflicts in ${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}. Nothing was changed.`,
            conflicts
          }
        return { status: 'refused', message: `Git could not merge ${base}: ${errorText(error)}` }
      }
    } finally {
      this.busy.delete(row.id)
    }
  }

  /** Records use, so the limit removes the least recently used worktree first. */
  touchProject(projectId: string): void {
    this.db
      .prepare('UPDATE managed_worktrees SET last_used_at = ? WHERE project_id = ?')
      .run(Date.now(), projectId)
  }
}
