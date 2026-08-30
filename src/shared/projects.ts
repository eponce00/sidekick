export interface Project {
  id: string
  name: string
  folder_path: string
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
  unread_completion_at?: number | null
  forked_from_conversation_id?: string | null
  forked_from_message_id?: string | null
  title_source?: import('./conversationTitles').ConversationTitleSource
  title_version?: number
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

export interface ConversationProjectContext {
  conversationId: string
  projectId: string | null
  projectName: string | null
  workspaceRoot: string | null
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
