import type { Project, ProjectConversation } from './projects'

/** Where a new project chat does its work before its first message. */
export type WorkInChoice = 'folder' | 'worktree'

export interface ManagedWorktreeOwner {
  kind: 'chat'
  id: string
  title: string
  running: boolean
}

export type WorktreeRemovalBlockerCode =
  | 'running'
  | 'in-use'
  | 'modified'
  | 'unmerged'
  | 'missing'
  | 'unmanaged'

export interface WorktreeRemovalBlocker {
  code: WorktreeRemovalBlockerCode
  message: string
  /** Forced removal can override this blocker after confirmation. */
  forceable: boolean
}

export interface ManagedWorktreeSummary {
  id: string
  projectId: string
  projectName: string
  /** The project folder: the worktree root, or the same subfolder the source project used. */
  folderPath: string
  worktreeRoot: string
  sourceProjectId: string
  sourceProjectName: string | null
  /** The branch SideKick created for it; null when it started detached at its base. */
  branch: string | null
  /** The branch or commit this worktree started from; null for worktrees from before bases were recorded. */
  baseRef: string | null
  createdAt: number
  lastUsedAt: number
  owners: ManagedWorktreeOwner[]
  /** Null when the folder is gone or Git could not read it. */
  status: ManagedWorktreeGitStatus | null
  blockers: WorktreeRemovalBlocker[]
}

export interface ManagedWorktreeGitStatus {
  currentBranch: string | null
  /** Commits in the worktree that its base does not have. */
  ahead: number | null
  /** Commits on the base that the worktree does not have. */
  behind: number | null
  /** Uncommitted entries reported by `git status --porcelain`, untracked files included. */
  changedFiles: number
  /**
   * Removing it loses no commits: they are all in its base or the source checkout's HEAD, or, for
   * a detached worktree, on some branch.
   */
  merged: boolean
}

export interface ManagedWorktreeDiskUsage {
  id: string
  bytes: number
  /** The walk stopped at its file or time budget, so `bytes` is a lower bound. */
  truncated: boolean
}

export interface WorktreeBranchOptions {
  /** Local branches of the project's repository, current branch first. */
  branches: string[]
  currentBranch: string | null
  /** Whether the project is inside a Git repository at all. */
  isGitRepository: boolean
  /** The project is itself a SideKick worktree; new worktrees then start from its source. */
  isManagedWorktree: boolean
}

export interface CreateConversationWorktreeInput {
  conversationId: string
  /** Branch or commit to start from; defaults to the source checkout's HEAD. */
  baseRef?: string
}

export interface CreateConversationWorktreeResult {
  project: Project
  conversation: ProjectConversation
  worktree: ManagedWorktreeSummary
}

export interface RemoveManagedWorktreeInput {
  id: string
  /** Discard uncommitted changes and detach the chats that use it. Never overrides a running agent. */
  force?: boolean
  /** Also delete the branch, even when it has commits its base does not. Only with `force`. */
  deleteBranch?: boolean
}

export interface RemoveManagedWorktreeResult {
  removed: boolean
  blockers: WorktreeRemovalBlocker[]
  /** The branch was left in the repository so its commits stay recoverable. */
  keptBranch?: string
  detachedConversationIds?: string[]
}

export type SyncManagedWorktreeResult =
  | { status: 'up-to-date' | 'merged'; message: string }
  | { status: 'conflict'; message: string; conflicts: string[] }
  | { status: 'refused'; message: string }

/** Another run that is writing in the same folder, or in a folder that contains or is inside it. */
export interface WorkspaceOccupant {
  runId: string
  conversationId: string
  title: string
  workspaceRoot: string
}

const BUSY_MARKER = '[workspace-busy]'

/**
 * The runtime refuses a run in a busy folder with this message. Errors cross IPC as plain
 * messages, so the occupants travel inside it as JSON after a stable marker.
 */
export function workspaceBusyMessage(occupants: readonly WorkspaceOccupant[]): string {
  const names = occupants.map(({ title }) => `“${title}”`).join(', ')
  return `Another agent is already working in this folder (${names}). Start in a new worktree, or send again and choose to share the folder. ${BUSY_MARKER}${JSON.stringify(occupants)}`
}

export function parseWorkspaceBusyMessage(message: string): WorkspaceOccupant[] | null {
  const index = message.indexOf(BUSY_MARKER)
  if (index < 0) return null
  try {
    const parsed = JSON.parse(message.slice(index + BUSY_MARKER.length)) as unknown
    return Array.isArray(parsed) ? (parsed as WorkspaceOccupant[]) : null
  } catch {
    return null
  }
}

/** The message without its machine-readable tail, for display. */
export function workspaceBusyDisplayMessage(message: string): string {
  const index = message.indexOf(BUSY_MARKER)
  return (index < 0 ? message : message.slice(0, index)).trim()
}

/**
 * What a worktree is on, for display: the branch checked out in it now (one the agent made, too),
 * else the branch SideKick created, else the base it is a detached copy of.
 */
export function worktreeBranchLabel(
  worktree: Pick<ManagedWorktreeSummary, 'branch' | 'baseRef' | 'status'>
): string {
  const branch = worktree.status?.currentBranch ?? worktree.branch
  if (branch) return branch
  const base = worktree.baseRef
  const shortBase = base && /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 7) : base
  return shortBase ? `detached from ${shortBase}` : 'detached'
}

export function worktreeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (slug.length <= 32) return slug || 'chat'
  // Cut at a word boundary so a branch never ends in half a word.
  const cut = slug.slice(0, 33)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 8 ? cut.slice(0, boundary) : slug.slice(0, 32)).replace(/-$/, '')
}

export interface WorktreesAPI {
  list: () => Promise<ManagedWorktreeSummary[]>
  diskUsage: (id: string) => Promise<ManagedWorktreeDiskUsage>
  branchOptions: (projectId: string) => Promise<WorktreeBranchOptions>
  createForConversation: (
    input: CreateConversationWorktreeInput
  ) => Promise<CreateConversationWorktreeResult>
  remove: (input: RemoveManagedWorktreeInput) => Promise<RemoveManagedWorktreeResult>
  sync: (id: string) => Promise<SyncManagedWorktreeResult>
  reveal: (id: string) => Promise<void>
}
