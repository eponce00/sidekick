import type { ProjectConversation } from './projects'

/** Where a new project chat does its work before its first message. */
export type WorkInChoice = 'folder' | 'worktree'

export interface ManagedWorktreeOwner {
  kind: 'chat'
  id: string
  title: string
  running: boolean
}

/**
 * A chat's own copy of its project. The chat stays in its project; only its folder is the
 * worktree's.
 */
export interface ManagedWorktreeSummary {
  id: string
  /** Where its chats work: the worktree root, or the same subfolder the project uses. */
  folderPath: string
  worktreeRoot: string
  /** The project it is a copy of, which its chats belong to. */
  sourceProjectId: string
  sourceProjectName: string | null
  /**
   * The branch it was on when set aside, or the one SideKick created for worktrees made before
   * they started detached. The live branch is in `status`.
   */
  branch: string | null
  /** The branch or commit this worktree started from; null for worktrees from before bases were recorded. */
  baseRef: string | null
  createdAt: number
  lastUsedAt: number
  /**
   * When SideKick set it aside to keep the number of worktrees on disk down; null while its folder
   * is on disk. Its chat's next run brings it back as it was.
   */
  setAsideAt: number | null
  owners: ManagedWorktreeOwner[]
  /** Null when it is set aside, its folder is gone, or Git could not read it. */
  status: ManagedWorktreeGitStatus | null
}

export interface ManagedWorktreeGitStatus {
  currentBranch: string | null
  /** Commits in the worktree that its base does not have. */
  ahead: number | null
  /** Uncommitted entries reported by `git status --porcelain`, untracked files included. */
  changedFiles: number
}

export interface WorktreeBranchOptions {
  /** Local branches of the project's repository, current branch first. */
  branches: string[]
  currentBranch: string | null
  /** Whether the project is inside a Git repository at all. */
  isGitRepository: boolean
}

export interface CreateConversationWorktreeInput {
  conversationId: string
  /** Branch or commit to start from; defaults to the source checkout's HEAD. */
  baseRef?: string
}

export interface CreateConversationWorktreeResult {
  conversation: ProjectConversation
  worktree: ManagedWorktreeSummary
}

export interface RemoveManagedWorktreeResult {
  removed: boolean
  /** Why it was kept, when it was. */
  reason?: string
}

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

/** The longest slug in a worktree folder name, so the whole path stays short on Windows. */
export const WORKTREE_SLUG_MAX_LENGTH = 20

/**
 * The readable part of a worktree folder name, from a worker's handle or a chat's title: lowercase
 * letters, digits and single dashes, so it is a safe single path segment on every platform.
 */
export function worktreeSlug(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (slug.length <= WORKTREE_SLUG_MAX_LENGTH) return slug || 'chat'
  // Cut at a word boundary so the name never ends in half a word.
  const cut = slug.slice(0, WORKTREE_SLUG_MAX_LENGTH + 1)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 6 ? cut.slice(0, boundary) : slug.slice(0, WORKTREE_SLUG_MAX_LENGTH)).replace(
    /-$/,
    ''
  )
}

export interface WorktreesAPI {
  list: () => Promise<ManagedWorktreeSummary[]>
  branchOptions: (projectId: string) => Promise<WorktreeBranchOptions>
  createForConversation: (
    input: CreateConversationWorktreeInput
  ) => Promise<CreateConversationWorktreeResult>
  remove: (id: string) => Promise<RemoveManagedWorktreeResult>
  reveal: (id: string) => Promise<void>
}
