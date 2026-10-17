import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import type Database from 'better-sqlite3'
import type { ProjectConversation } from '../../shared/projects'
import {
  worktreeSlug,
  type CreateConversationWorktreeInput,
  type CreateConversationWorktreeResult,
  type ManagedWorktreeGitStatus,
  type ManagedWorktreeOwner,
  type ManagedWorktreeSummary,
  type RemoveManagedWorktreeResult,
  type WorktreeBranchOptions
} from '../../shared/worktrees'
import { ProjectStore } from './projectStore'
import { shellChildEnvironment } from './commandService'

const execFileAsync = promisify(execFile)
/**
 * Worktrees kept on disk. Older ones are set aside with a snapshot and come back when their chat
 * runs again, as Codex does with the same number.
 */
export const MAX_WORKTREES_ON_DISK = 15
const LINK_WALK_ENTRY_LIMIT = 200_000
/** Holds a set-aside worktree's snapshot, so Git keeps its commits and changes. */
const SNAPSHOT_REF_PREFIX = 'refs/sidekick/worktrees/'
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'SideKick',
  GIT_AUTHOR_EMAIL: 'sidekick@localhost',
  GIT_COMMITTER_NAME: 'SideKick',
  GIT_COMMITTER_EMAIL: 'sidekick@localhost'
}

interface ManagedWorktreeRow {
  id: string
  source_project_id: string
  repository_root: string
  worktree_root: string
  /** Where its chats work: the root, or the subfolder the source project uses. */
  folder_path: string | null
  /** The branch SideKick created for it; null when it started detached at its base. */
  branch: string | null
  base_ref: string | null
  created_at: number
  last_used_at: number
  /** When it was set aside; null while its folder is on disk. */
  set_aside_at: number | null
  set_aside_head: string | null
  set_aside_branch: string | null
  /** HEAD plus every uncommitted file Git does not ignore, as one commit. */
  snapshot_commit: string | null
}

async function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    {
      windowsHide: true,
      env: { ...shellChildEnvironment(process.env, cwd, cwd), ...extraEnv },
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

/** A branch or commit given by the user, never an option Git could misread. */
function validRef(ref: string): boolean {
  return /^[A-Za-z0-9._/@^~-]{1,200}$/.test(ref) && !ref.startsWith('-')
}

/** A branch name as it is, a commit as its short form. */
function shortRef(ref: string | null): string {
  if (!ref) return 'its start'
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref
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
      if (++entries > LINK_WALK_ENTRY_LIMIT)
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
  /** One change at a time per worktree: setting aside, restoring and removing wait their turn. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private housekeeping: Promise<void> = Promise.resolve()

  private readonly maxOnDisk: number

  constructor(
    private readonly db: Database.Database,
    private readonly storageRoot: string,
    options: { maxOnDisk?: number } = {}
  ) {
    this.projects = new ProjectStore(db)
    this.maxOnDisk = options.maxOnDisk ?? MAX_WORKTREES_ON_DISK
  }

  private serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(action)
    const settled = next.catch(() => undefined)
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return next
  }

  private rowsOldestFirst(): ManagedWorktreeRow[] {
    return this.db
      .prepare('SELECT * FROM managed_worktrees ORDER BY last_used_at ASC, created_at ASC')
      .all() as ManagedWorktreeRow[]
  }

  private findRow(id: string): ManagedWorktreeRow | undefined {
    return this.db.prepare('SELECT * FROM managed_worktrees WHERE id = ?').get(id) as
      | ManagedWorktreeRow
      | undefined
  }

  private row(id: string): ManagedWorktreeRow {
    const row = this.findRow(id)
    if (!row) throw new Error('This worktree is no longer managed by SideKick')
    return row
  }

  private rowForConversation(conversationId: string): ManagedWorktreeRow | undefined {
    return this.db
      .prepare(
        `SELECT w.* FROM managed_worktrees w
         JOIN conversations c ON c.worktree_id = w.id
         WHERE c.id = ?`
      )
      .get(conversationId) as ManagedWorktreeRow | undefined
  }

  /** The worktree a chat works in, if any. */
  worktreeIdFor(conversationId: string): string | null {
    return this.rowForConversation(conversationId)?.id ?? null
  }

  /** Where a worktree started, for messages: its branch, or the base it is a detached copy of. */
  location(id: string): string | null {
    const row = this.findRow(id)
    if (!row) return null
    return row.branch ? `on ${row.branch}` : `detached from ${shortRef(row.base_ref)}`
  }

  private owners(id: string): ManagedWorktreeOwner[] {
    const chats = this.db
      .prepare('SELECT id, title FROM conversations WHERE worktree_id = ? ORDER BY updated_at DESC')
      .all(id) as Array<{ id: string; title: string }>
    return chats.map(({ id, title }) => ({
      kind: 'chat' as const,
      id,
      title,
      running: this.projects.hasActiveRun(id)
    }))
  }

  private running(id: string): boolean {
    return this.owners(id).some(({ running }) => running)
  }

  private pinned(id: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM conversations WHERE worktree_id = ? AND is_pinned = 1 LIMIT 1')
        .get(id)
    )
  }

  /**
   * Where a set-aside worktree's folder goes back: its recorded path, only when that is exactly
   * where SideKick puts worktrees, inside its storage under the source project.
   */
  private async restorePath(row: ManagedWorktreeRow): Promise<string | null> {
    const child = relative(resolve(this.storageRoot), resolve(row.worktree_root))
    const parts = child.split(sep)
    if (parts.length !== 2 || parts[0] !== row.source_project_id || parts[1].startsWith('.'))
      return null
    try {
      const [storage, parent] = await Promise.all([
        fs.realpath(this.storageRoot),
        fs.realpath(join(this.storageRoot, row.source_project_id))
      ])
      return samePath(join(storage, row.source_project_id), parent) ? join(parent, parts[1]) : null
    } catch {
      return null
    }
  }

  /** The worktree folder, only when it exists, is SideKick's, and Git still lists it. */
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
      const [currentBranch, porcelain, ahead] = await Promise.all([
        git(target, ['branch', '--show-current']),
        git(target, ['status', '--porcelain']),
        row.base_ref
          ? git(target, ['rev-list', '--count', `${row.base_ref}..HEAD`]).then(Number, () => NaN)
          : Promise.resolve(NaN)
      ])
      return {
        currentBranch: currentBranch || null,
        ahead: Number.isFinite(ahead) ? ahead : null,
        changedFiles: porcelain ? porcelain.split('\n').filter(Boolean).length : 0
      }
    } catch {
      return null
    }
  }

  private async summary(row: ManagedWorktreeRow): Promise<ManagedWorktreeSummary> {
    const source = this.projects.get(row.source_project_id)
    const target = row.set_aside_at ? null : await this.managedTarget(row)
    return {
      id: row.id,
      folderPath: row.folder_path ?? row.worktree_root,
      worktreeRoot: row.worktree_root,
      sourceProjectId: row.source_project_id,
      sourceProjectName: source?.name ?? null,
      branch: row.set_aside_branch ?? row.branch,
      baseRef: row.base_ref,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      setAsideAt: row.set_aside_at,
      owners: this.owners(row.id),
      status: target ? await this.gitStatus(row, target) : null
    }
  }

  async list(): Promise<ManagedWorktreeSummary[]> {
    return Promise.all(
      this.rowsOldestFirst()
        .reverse()
        .map((row) => this.summary(row))
    )
  }

  async get(id: string): Promise<ManagedWorktreeSummary> {
    return this.summary(this.row(id))
  }

  /** Branches a new worktree can start from, for the project a chat is in. */
  async branchOptions(projectId: string): Promise<WorktreeBranchOptions> {
    const project = this.projects.get(projectId)
    const empty = { branches: [], currentBranch: null, isGitRepository: false }
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
      isGitRepository: true
    }
  }

  /** Sets older worktrees aside in the background, after a chat starts using `keepId`. */
  private scheduleHousekeeping(keepId: string): void {
    this.housekeeping = this.housekeeping
      .then(() => this.setAsideBeyondLimit(keepId))
      .catch((error) => console.warn('[Worktrees] Setting older worktrees aside failed:', error))
  }

  /** Resolves once background housekeeping has finished. */
  settled(): Promise<void> {
    return this.housekeeping
  }

  /**
   * Keeps at most `maxOnDisk` folders, setting aside the least recently used first. A
   * worktree with a running or pinned chat, or the one just used, stays.
   */
  private async setAsideBeyondLimit(keepId: string): Promise<void> {
    const onDisk = this.rowsOldestFirst().filter(({ set_aside_at }) => !set_aside_at)
    let excess = onDisk.length - this.maxOnDisk
    for (const row of onDisk) {
      if (excess <= 0) return
      if (row.id === keepId || this.pinned(row.id) || this.running(row.id)) continue
      try {
        if (await this.serialized(row.id, () => this.setAsideNow(row.id))) excess--
      } catch (error) {
        console.warn('[Worktrees] Could not set a worktree aside:', error)
      }
    }
  }

  /**
   * Snapshots a worktree into a commit kept by a SideKick ref, then deletes its folder. Its commits
   * and uncommitted files, except those Git ignores, come back when it is restored.
   */
  private async setAsideNow(id: string): Promise<boolean> {
    const row = this.findRow(id)
    if (!row || row.set_aside_at || this.running(row.id)) return false
    const target = await this.managedTarget(row)
    if (!target) return false
    const head = await git(target, ['rev-parse', 'HEAD'])
    const branch = (await git(target, ['branch', '--show-current']).catch(() => '')) || null
    const changes = await git(target, ['status', '--porcelain'])
    const snapshot = changes ? await this.snapshot(target, head) : head
    await git(row.repository_root, ['update-ref', `${SNAPSHOT_REF_PREFIX}${row.id}`, snapshot])
    // Something written since the snapshot would be lost, so the worktree stays this time.
    if (this.running(row.id) || (await git(target, ['status', '--porcelain'])) !== changes) {
      await git(row.repository_root, ['update-ref', '-d', `${SNAPSHOT_REF_PREFIX}${row.id}`])
      return false
    }
    for (const link of await findLinks(target)) await unlinkWithoutFollowing(link)
    await git(row.repository_root, ['worktree', 'remove', '--force', target])
    this.db
      .prepare(
        `UPDATE managed_worktrees
         SET set_aside_at = ?, set_aside_head = ?, set_aside_branch = ?, snapshot_commit = ?
         WHERE id = ?`
      )
      .run(Date.now(), head, branch, snapshot, row.id)
    return true
  }

  /** A commit on HEAD holding every file Git does not ignore, as it is in the worktree now. */
  private async snapshot(target: string, head: string): Promise<string> {
    // A private index, so the worktree's own staging area is never touched.
    const index = join(tmpdir(), `sidekick-snapshot-${randomUUID()}.index`)
    const env = { GIT_INDEX_FILE: index, ...SNAPSHOT_IDENTITY }
    try {
      await git(target, ['read-tree', head], env)
      await git(target, ['add', '--all'], env)
      const tree = await git(target, ['write-tree'], env)
      return await git(
        target,
        ['commit-tree', tree, '-p', head, '-m', 'SideKick snapshot of a set-aside worktree'],
        env
      )
    } finally {
      await fs.rm(index, { force: true })
    }
  }

  /** Brings a set-aside worktree back as it was: same folder, commit, branch and files. */
  private async restoreNow(id: string): Promise<void> {
    const row = this.findRow(id)
    if (!row?.set_aside_at || !row.set_aside_head || !row.snapshot_commit) return
    const target = await this.restorePath(row)
    if (!target)
      throw new Error('This worktree is outside SideKick storage, so it was not restored')
    if (
      await fs.stat(target).then(
        () => true,
        () => false
      )
    )
      throw new Error(`Something else is now at ${target}, so the worktree was not restored`)
    const branch = row.set_aside_branch
    const branchTip = branch
      ? await git(row.repository_root, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`
        ]).catch(() => '')
      : ''
    // Back on its branch when the branch has not moved and is not checked out elsewhere.
    const onBranch =
      branch !== null &&
      branchTip === row.set_aside_head &&
      (await gitSucceeds(row.repository_root, ['worktree', 'add', target, branch]))
    if (!onBranch)
      await git(row.repository_root, ['worktree', 'add', '--detach', target, row.set_aside_head])
    if (row.snapshot_commit !== row.set_aside_head) {
      // Writes the snapshot's files, deletions included, then unstages them.
      await git(target, ['read-tree', '--reset', '-u', row.snapshot_commit])
      await git(target, ['reset', '--quiet'])
    }
    await git(row.repository_root, ['update-ref', '-d', `${SNAPSHOT_REF_PREFIX}${row.id}`]).catch(
      () => undefined
    )
    this.db
      .prepare(
        `UPDATE managed_worktrees
         SET set_aside_at = NULL, set_aside_head = NULL, set_aside_branch = NULL,
             snapshot_commit = NULL, last_used_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), row.id)
  }

  /**
   * Readies a chat's worktree before a run: restores it if it was set aside, and records the use so
   * the least recently used worktrees are set aside first. Other chats are untouched.
   */
  prepareConversation(conversationId: string): Promise<void> | undefined {
    const row = this.rowForConversation(conversationId)
    if (!row) return undefined
    const touch = (): void => {
      this.db
        .prepare('UPDATE managed_worktrees SET last_used_at = ? WHERE id = ?')
        .run(Date.now(), row.id)
      this.scheduleHousekeeping(row.id)
    }
    // A worktree on disk with nothing pending is ready now, so the run starts without a wait.
    if (!row.set_aside_at && !this.queues.has(row.id)) {
      touch()
      return undefined
    }
    return this.serialized(row.id, () => this.restoreNow(row.id)).then(touch)
  }

  /**
   * Creates a SideKick worktree of a project, detached at its base as Codex and OpenCode do: the
   * base branch stays checked out where it already is, and the agent creates a branch when its
   * work needs one. `fromWorktreeId` starts it from another worktree's commit instead, as when a
   * chat in a worktree forks into a new one.
   */
  async create(
    projectId: string,
    conversationTitle: string,
    options: { baseRef?: string; fromWorktreeId?: string | null } = {}
  ): Promise<ManagedWorktreeSummary> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error('Invalid project identity')
    const source = this.projects.get(projectId)
    if (!source) throw new Error('The project no longer exists')
    if (options.baseRef !== undefined && !validRef(options.baseRef))
      throw new Error('That base is not a valid branch or commit')
    const parentWorktree = options.fromWorktreeId ? this.findRow(options.fromWorktreeId) : undefined
    // Starting from a set-aside worktree needs its folder back first.
    if (parentWorktree)
      await this.serialized(parentWorktree.id, () => this.restoreNow(parentWorktree.id))

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
    const startFrom = parentWorktree
      ? (parentWorktree.folder_path ?? parentWorktree.worktree_root)
      : source.folder_path
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
    const name = `${worktreeSlug(conversationTitle)}-${id.slice(0, 8)}`
    const worktreeRoot = join(this.storageRoot, projectId, name)
    const folderPath = sourceSubdirectory ? join(worktreeRoot, sourceSubdirectory) : worktreeRoot
    await fs.mkdir(join(this.storageRoot, projectId), { recursive: true })
    const [canonicalStorage, canonicalParent] = await Promise.all([
      fs.realpath(this.storageRoot),
      fs.realpath(join(this.storageRoot, projectId))
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
      await git(repositoryRoot, ['worktree', 'add', '--detach', worktreeRoot, baseRef])
      created = true
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO managed_worktrees
           (id, source_project_id, repository_root, worktree_root, folder_path, branch, base_ref,
            created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(id, projectId, repositoryRoot, worktreeRoot, folderPath, baseRef, now, now)
      this.scheduleHousekeeping(id)
      return await this.get(id)
    } catch (error) {
      // A cleanup failure leaves recoverable Git state rather than deleting anything by force.
      if (created) {
        this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(id)
        try {
          await git(repositoryRoot, ['worktree', 'remove', worktreeRoot])
        } catch {
          /* Preserve files and refs for manual recovery. */
        }
      }
      throw error
    }
  }

  /**
   * Gives a chat that has not started yet its own worktree. The chat stays in its project; only
   * its folder changes. The entry point for "Work in: new worktree" and for chats another agent
   * starts.
   */
  async createForConversation(
    input: CreateConversationWorktreeInput
  ): Promise<CreateConversationWorktreeResult> {
    const conversation = this.db
      .prepare('SELECT id, title, project_id, worktree_id FROM conversations WHERE id = ?')
      .get(input.conversationId) as
      | Pick<ProjectConversation, 'id' | 'title' | 'project_id' | 'worktree_id'>
      | undefined
    if (!conversation) throw new Error('Conversation not found')
    if (!conversation.project_id) throw new Error('Only a chat in a project can use a worktree')
    if (conversation.worktree_id) throw new Error('This chat already works in a worktree')
    const hasHistory =
      this.db
        .prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1')
        .get(conversation.id) ||
      this.db.prepare('SELECT 1 FROM agent_runs WHERE thread_id = ? LIMIT 1').get(conversation.id)
    if (hasHistory)
      throw new Error('This chat already has messages. Fork it into a new worktree instead.')
    const worktree = await this.create(conversation.project_id, conversation.title, {
      baseRef: input.baseRef
    })
    try {
      this.db
        .prepare(
          `UPDATE conversations
           SET worktree_id = ?, project_context_version = project_context_version + 1
           WHERE id = ?`
        )
        .run(worktree.id, conversation.id)
      const moved = this.db
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(conversation.id) as ProjectConversation
      return {
        conversation: { ...moved, worktree_folder: worktree.folderPath },
        worktree: await this.get(worktree.id)
      }
    } catch (error) {
      await this.discardFresh(worktree.id).catch(() => undefined)
      throw error
    }
  }

  /** Removes a worktree made a moment ago for a chat or fork that then failed to start. */
  async discardFresh(id: string): Promise<void> {
    if (!this.findRow(id)) return
    const result = await this.serialized(id, () => this.removeNow(id, { onlyIfClean: true }))
    if (!result.removed) throw new Error(`Worktree cleanup refused: ${result.reason}`)
  }

  /**
   * Whether a chat that was opened and left unused may go, taking its worktree with it. Shared by
   * other chats, the worktree stays; set aside or changed, the chat stays so nothing is lost.
   */
  async discardWithUnusedChat(id: string, conversationId: string): Promise<boolean> {
    const row = this.findRow(id)
    if (!row) return true
    if (this.owners(id).some((owner) => owner.id !== conversationId)) return true
    if (row.set_aside_at) return false
    try {
      const result = await this.serialized(id, () => this.removeNow(id, { onlyIfClean: true }))
      return result.removed
    } catch (error) {
      console.warn('[Worktrees] An unused chat kept its worktree:', error)
      return false
    }
  }

  /** Removes a worktree no chat uses any more, as when its last chat is deleted. */
  async removeIfUnused(id: string): Promise<RemoveManagedWorktreeResult | null> {
    if (!this.findRow(id) || this.owners(id).length) return null
    try {
      return await this.serialized(id, () => this.removeNow(id))
    } catch (error) {
      console.warn('[Worktrees] Automatic cleanup skipped:', error)
      return null
    }
  }

  /**
   * Deletes a worktree's folder with its uncommitted changes. Its chats keep their history as
   * chats outside any project, and commits on a branch stay in the repository.
   */
  async remove(id: string): Promise<RemoveManagedWorktreeResult> {
    this.row(id)
    return this.serialized(id, () => this.removeNow(id))
  }

  private async removeNow(
    id: string,
    options: { onlyIfClean?: boolean } = {}
  ): Promise<RemoveManagedWorktreeResult> {
    const row = this.findRow(id)
    if (!row) return { removed: true }
    if (this.running(row.id))
      return { removed: false, reason: 'An agent is working in it. Stop it first.' }
    if (!row.set_aside_at) {
      const exists = await fs.stat(row.worktree_root).then(
        (entry) => entry.isDirectory(),
        () => false
      )
      if (exists) {
        const target = await this.managedTarget(row)
        if (!target)
          return {
            removed: false,
            reason:
              'SideKick cannot prove it created this folder, so it will not delete it. Remove it with Git yourself.'
          }
        if (options.onlyIfClean && (await git(target, ['status', '--porcelain'])))
          return { removed: false, reason: 'It has changes, so it was kept for you to recover.' }
        for (const link of await findLinks(target)) await unlinkWithoutFollowing(link)
        await git(row.repository_root, ['worktree', 'remove', '--force', target])
      } else {
        await git(row.repository_root, ['worktree', 'prune']).catch(() => undefined)
      }
    }
    await git(row.repository_root, ['update-ref', '-d', `${SNAPSHOT_REF_PREFIX}${row.id}`]).catch(
      () => undefined
    )
    // The folder is gone, so its chats keep their history as chats outside any project instead of
    // silently working in the project folder.
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE conversations
           SET worktree_id = NULL, project_id = NULL,
               project_context_version = project_context_version + 1,
               home_workspace_root = ?
           WHERE worktree_id = ?`
        )
        .run(row.folder_path ?? row.worktree_root, row.id)
      this.db.prepare('DELETE FROM managed_worktrees WHERE id = ?').run(row.id)
    })()
    return { removed: true }
  }
}
