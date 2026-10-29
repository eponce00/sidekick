/**
 * A folder of a project besides its primary one. The agent addresses it by name, as
 * `<name>/path`; relative paths without a folder name mean the primary folder.
 */
export interface WorkspaceFolder {
  name: string
  path: string
}

export interface Project {
  id: string
  name: string
  /** The primary folder: where commands start, and whose Git, instructions and memory apply. */
  folder_path: string
  /** The project's other folders, in the order they were added. */
  folders?: WorkspaceFolder[]
  is_pinned: number
  created_at: number
  updated_at: number
  conversation_count?: number
  last_activity_at?: number
}

export interface ProjectConversation {
  id: string
  title: string
  created_at: number
  updated_at: number
  project_id: string | null
  is_pinned?: number
  sidebar_order: number
  project_context_version: number
  home_workspace_root: string | null
  home_project_name: string | null
  /** The chat's own worktree of its project, when it works in one. */
  worktree_id?: string | null
  /** That worktree's folder, where the chat works instead of the project folder. */
  worktree_folder?: string | null
  unread_completion_at?: number | null
  forked_from_conversation_id?: string | null
  forked_from_message_id?: string | null
  title_source?: import('./conversationTitles').ConversationTitleSource
  title_version?: number
  /** The schedule that created this chat, and which of its runs it is. */
  schedule_id?: string | null
  schedule_run_number?: number | null
  /** Family links for chats started by other chats; see `SessionLink` in ./sessions. */
  started_by_kind?: import('./sessions').SessionStarterKind
  started_by_conversation_id?: string | null
  report_to_conversation_id?: string | null
  session_handle?: string | null
  work_in?: import('./sessions').SessionWorkIn | null
  archived_at?: number | null
  /** The most this chat may do without asking; stricter than the setting. See `effectivePermissionMode`. */
  permission_ceiling?: import('./permissions').PermissionMode | null
  /** The model this chat runs with; see `conversationModelChoice`. */
  model_id?: string | null
}

export interface ForkConversationInput {
  sourceId: string
  messageId?: string
  workspaceMode: 'current' | 'worktree'
}

export type ConversationPlacement = 'before' | 'after' | 'start' | 'end'

export interface MoveConversationInput {
  conversationId: string
  projectId: string | null
  anchorConversationId?: string | null
  placement?: ConversationPlacement
  expectedProjectContextVersion?: number
}

export interface ConversationProjectTransition {
  id: string
  conversationId: string
  fromProjectId: string | null
  toProjectId: string | null
  fromProjectName: string | null
  toProjectName: string | null
  fromWorkspaceRoot: string | null
  toWorkspaceRoot: string | null
  movedAt: number
}

export interface ConversationWorktreeContext {
  /** The project folder the worktree is a copy of, which keeps its own checkout. */
  projectFolder: string | null
  /** The branch SideKick made for it; null for worktrees made while they started detached. */
  branch: string | null
  /** The branch or commit it started from. */
  base: string | null
}

export interface ConversationProjectContext {
  conversationId: string
  projectId: string | null
  projectName: string | null
  /**
   * Where the chat works: its worktree's folder when it has one, else the project folder, else,
   * for a chat that has never had a project, its own folder.
   */
  workspaceRoot: string | null
  /** The project's other folders, which the chat works in alongside workspaceRoot. */
  folders: WorkspaceFolder[]
  /** Set when workspaceRoot is the chat's own folder rather than a project's. */
  chatFolder?: boolean
  worktreeId: string | null
  /** For a chat in its own worktree: the project folder it is a copy of, its branch and base. */
  worktree?: ConversationWorktreeContext | null
  homeWorkspaceRoot: string | null
  homeProjectName: string | null
  isDetached: boolean
  contextVersion: number
  latestTransition: ConversationProjectTransition | null
}

export interface MoveConversationResult {
  conversation: ProjectConversation
  transition: ConversationProjectTransition | null
}

export interface UpdateProjectFoldersInput {
  projectId: string
  /** Folders to add, each one the user picked in the folder picker. */
  add?: string[]
  /** Extra folders to remove, by name. */
  remove?: string[]
  /** An extra folder to make the primary one, by name; the primary becomes an extra folder. */
  makePrimary?: string
}
