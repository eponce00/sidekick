// Renderer-facing application types. Cross-process settings live in shared.

export type { ProviderSettings } from '../../../shared/settings'
export type { Project } from '../../../shared/projects'

export {
  DEFAULT_TOOL_CALL_LIMIT,
  MIN_TOOL_CALL_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  TOOL_CALL_LIMIT_POLICY_VERSION
} from '../../../shared/agentLimits'

export interface Conversation {
  id: string
  title: string
  created_at: number
  updated_at: number
  project_id: string | null
  title_source?: import('../../../shared/conversationTitles').ConversationTitleSource
  title_version?: number
  sidebar_order: number
  project_context_version: number
  home_workspace_root: string | null
  home_project_name: string | null
  unread_completion_at?: number | null
}
