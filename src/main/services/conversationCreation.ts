import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  conversationTitleVersionForSource,
  type ConversationTitleSource
} from '../../shared/conversationTitles'

export interface CreatedConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  project_id: string | null
  is_pinned: 0
  title_source: ConversationTitleSource
  title_version: number
  sidebar_order: number
  project_context_version: 0
  home_workspace_root: string | null
  home_project_name: string | null
  unread_completion_at: null
  model_id: string | null
}

/** Adds a chat at the top of its project's list (or of chats without one), as the sidebar shows. */
export function createConversation(
  db: Database.Database,
  input: {
    title: string
    projectId: string | null
    titleSource: ConversationTitleSource
    modelId: string | null
    now?: number
  }
): CreatedConversationRow {
  const id = randomUUID()
  const now = input.now ?? Date.now()
  const titleVersion = conversationTitleVersionForSource(input.titleSource)
  const project = input.projectId
    ? (db.prepare('SELECT name, folder_path FROM projects WHERE id = ?').get(input.projectId) as
        | { name: string; folder_path: string }
        | undefined)
    : undefined
  if (input.projectId && !project) throw new Error('Project not found')
  const placement = db
    .prepare(
      `SELECT COALESCE(MIN(sidebar_order), 0) - 1 AS sidebar_order
       FROM conversations WHERE project_id IS ?`
    )
    .get(input.projectId) as { sidebar_order: number }
  db.prepare(
    `INSERT INTO conversations
     (id, title, created_at, updated_at, project_id, title_source, title_version,
      sidebar_order, project_context_version, home_workspace_root, home_project_name, model_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    input.title,
    now,
    now,
    input.projectId,
    input.titleSource,
    titleVersion,
    placement.sidebar_order,
    project?.folder_path ?? null,
    project?.name ?? null,
    input.modelId
  )
  return {
    id,
    title: input.title,
    created_at: now,
    updated_at: now,
    project_id: input.projectId,
    is_pinned: 0,
    title_source: input.titleSource,
    title_version: titleVersion,
    sidebar_order: placement.sidebar_order,
    project_context_version: 0,
    home_workspace_root: project?.folder_path ?? null,
    home_project_name: project?.name ?? null,
    unread_completion_at: null,
    model_id: input.modelId
  }
}
