import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type {
  ConversationProjectContext,
  ConversationProjectTransition,
  MoveConversationInput,
  MoveConversationResult,
  Project,
  ProjectConversation
} from '../../shared/projects'

interface ProjectEventRow {
  id: string
  conversation_id: string
  from_project_id: string | null
  to_project_id: string | null
  from_project_name: string | null
  to_project_name: string | null
  from_workspace_root: string | null
  to_workspace_root: string | null
  moved_at: number
}

function mapTransition(row: ProjectEventRow): ConversationProjectTransition {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    fromProjectId: row.from_project_id,
    toProjectId: row.to_project_id,
    fromProjectName: row.from_project_name,
    toProjectName: row.to_project_name,
    fromWorkspaceRoot: row.from_workspace_root,
    toWorkspaceRoot: row.to_workspace_root,
    movedAt: row.moved_at
  }
}

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  list(): Project[] {
    return this.db
      .prepare(
        `SELECT
           p.*,
           COUNT(c.id) AS conversation_count,
           COALESCE(MAX(c.updated_at), p.updated_at) AS last_activity_at
         FROM projects p
         LEFT JOIN conversations c ON c.project_id = p.id
         GROUP BY p.id
         ORDER BY p.is_pinned DESC, last_activity_at DESC, p.name COLLATE NOCASE ASC`
      )
      .all() as Project[]
  }

  get(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
  }

  create(folderPath: string, name: string): Project {
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE folder_path = ?')
      .get(folderPath) as Project | undefined
    if (existing) return existing

    const project: Project = {
      id: randomUUID(),
      name,
      folder_path: folderPath,
      is_pinned: 0,
      created_at: Date.now(),
      updated_at: Date.now()
    }
    this.db
      .prepare(
        `INSERT INTO projects (id, name, folder_path, is_pinned, created_at, updated_at)
         VALUES (@id, @name, @folder_path, @is_pinned, @created_at, @updated_at)`
      )
      .run(project)
    return project
  }

  update(id: string, input: { name?: string; isPinned?: boolean }): Project {
    const current = this.get(id)
    if (!current) throw new Error('Project not found')
    const project: Project = {
      ...current,
      name: input.name?.trim() || current.name,
      is_pinned: input.isPinned == null ? current.is_pinned : input.isPinned ? 1 : 0,
      updated_at: Date.now()
    }
    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, is_pinned = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(project.name, project.is_pinned, project.updated_at, id)
    if (project.name !== current.name) {
      this.db
        .prepare(
          `UPDATE conversations
           SET home_project_name = ?
           WHERE home_workspace_root = ?`
        )
        .run(project.name, project.folder_path)
    }
    return project
  }

  touch(id: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  getConversationContext(conversationId: string): ConversationProjectContext {
    const conversation = this.db
      .prepare(
        `SELECT c.id, c.project_id, c.project_context_version,
                c.home_workspace_root, c.home_project_name,
                p.name, p.folder_path
         FROM conversations c
         LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = ?`
      )
      .get(conversationId) as
      | {
          id: string
          project_id: string | null
          project_context_version: number
          home_workspace_root: string | null
          home_project_name: string | null
          name: string | null
          folder_path: string | null
        }
      | undefined
    if (!conversation) throw new Error('Conversation not found')

    const event = this.db
      .prepare(
        `SELECT * FROM conversation_project_events
         WHERE conversation_id = ?
         ORDER BY moved_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(conversationId) as ProjectEventRow | undefined
    return {
      conversationId,
      projectId: conversation.project_id,
      projectName: conversation.name,
      workspaceRoot: conversation.folder_path,
      homeWorkspaceRoot: conversation.home_workspace_root,
      homeProjectName: conversation.home_project_name,
      isDetached: !conversation.project_id && Boolean(conversation.home_workspace_root),
      contextVersion: conversation.project_context_version,
      latestTransition: event ? mapTransition(event) : null
    }
  }

  moveConversation(input: MoveConversationInput): MoveConversationResult {
    return this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(input.conversationId) as ProjectConversation | undefined
      if (!current) throw new Error('Conversation not found')
      if (
        input.expectedProjectContextVersion !== undefined &&
        input.expectedProjectContextVersion !== current.project_context_version
      ) {
        throw new Error('Conversation project changed; refresh and try again')
      }

      const destination = input.projectId ? this.get(input.projectId) : undefined
      if (input.projectId && !destination) throw new Error('Project not found')
      const projectChanged = current.project_id !== input.projectId
      if (current.project_id && input.projectId && current.project_id !== input.projectId) {
        throw new Error(
          'Chats cannot move between projects. Detach it only if you want it to stay standalone.'
        )
      }
      if (
        destination &&
        current.home_workspace_root &&
        current.home_workspace_root !== destination.folder_path
      ) {
        throw new Error(
          `This chat belongs to ${current.home_project_name || current.home_workspace_root} and cannot move to another project`
        )
      }
      if (projectChanged && this.hasActiveRun(input.conversationId)) {
        throw new Error('Stop the active run before moving this chat')
      }

      const sourceProject = current.project_id ? this.get(current.project_id) : undefined
      const destinationRows = this.listConversationPlacement(input.projectId).filter(
        ({ id }) => id !== input.conversationId
      )
      const placement = input.placement ?? 'end'
      let insertAt = placement === 'start' ? 0 : destinationRows.length
      if (input.anchorConversationId) {
        const anchorIndex = destinationRows.findIndex(({ id }) => id === input.anchorConversationId)
        if (anchorIndex < 0) throw new Error('Drop target is not in the destination')
        insertAt = placement === 'after' ? anchorIndex + 1 : anchorIndex
      }
      destinationRows.splice(insertAt, 0, current)

      const now = Date.now()
      const nextContextVersion = current.project_context_version + (projectChanged ? 1 : 0)
      const homeWorkspaceRoot = current.home_workspace_root ?? destination?.folder_path ?? null
      const homeProjectName = destination?.name ?? current.home_project_name ?? null
      this.db
        .prepare(
          `UPDATE conversations
           SET project_id = ?, project_context_version = ?,
               home_workspace_root = ?, home_project_name = ?
           WHERE id = ?`
        )
        .run(
          input.projectId,
          nextContextVersion,
          homeWorkspaceRoot,
          homeProjectName,
          input.conversationId
        )
      this.rewriteOrder(
        input.projectId,
        destinationRows.map(({ id }) => id)
      )
      if (projectChanged) {
        const remainingSource = this.listConversationPlacement(current.project_id).filter(
          ({ id }) => id !== input.conversationId
        )
        this.rewriteOrder(
          current.project_id,
          remainingSource.map(({ id }) => id)
        )
      }

      let transition: ConversationProjectTransition | null = null
      if (projectChanged) {
        transition = {
          id: randomUUID(),
          conversationId: input.conversationId,
          fromProjectId: current.project_id,
          toProjectId: input.projectId,
          fromProjectName: sourceProject?.name ?? null,
          toProjectName: destination?.name ?? null,
          fromWorkspaceRoot: sourceProject?.folder_path ?? null,
          toWorkspaceRoot: destination?.folder_path ?? null,
          movedAt: now
        }
        this.insertTransition(transition)
      }

      if (current.project_id) this.touch(current.project_id)
      if (input.projectId) this.touch(input.projectId)
      const conversation = this.db
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(input.conversationId) as ProjectConversation
      return { conversation, transition }
    })()
  }

  remove(id: string): void {
    this.db.transaction(() => {
      const project = this.get(id)
      if (!project) throw new Error('Project not found')
      const projectConversations = this.listConversationPlacement(id)
      if (
        projectConversations.some(({ id: conversationId }) => this.hasActiveRun(conversationId))
      ) {
        throw new Error('Stop active runs before removing this project')
      }

      const collaborationParticipants = this.db
        .prepare(
          `SELECT p.id, p.group_id, p.label, project.name AS project_name
           FROM collaboration_participants p
           JOIN projects project ON project.id = p.project_id
           WHERE p.project_id = ?`
        )
        .all(id) as Array<{
        id: string
        group_id: string
        label: string
        project_name: string
      }>
      if (collaborationParticipants.length) {
        const groupIds = [...new Set(collaborationParticipants.map(({ group_id }) => group_id))]
        const placeholders = groupIds.map(() => '?').join(', ')
        const activeGroupMission = this.db
          .prepare(
            `SELECT 1 FROM collaboration_missions
             WHERE group_id IN (${placeholders}) AND status IN ('queued', 'running') LIMIT 1`
          )
          .get(...groupIds)
        if (activeGroupMission) {
          throw new Error('Stop active group missions before removing this project')
        }

        const eventRows = this.db.prepare(
          'SELECT id, payload_json FROM collaboration_events WHERE actor_participant_id = ?'
        )
        const updateEvent = this.db.prepare(
          'UPDATE collaboration_events SET payload_json = ? WHERE id = ?'
        )
        for (const participant of collaborationParticipants) {
          const events = eventRows.all(participant.id) as Array<{
            id: string
            payload_json: string
          }>
          for (const event of events) {
            let payload: Record<string, unknown> = {}
            try {
              payload = JSON.parse(event.payload_json) as Record<string, unknown>
            } catch {
              // Preserve the event and add the actor snapshot below.
            }
            updateEvent.run(
              JSON.stringify({
                ...payload,
                metadata: {
                  ...(payload.metadata && typeof payload.metadata === 'object'
                    ? (payload.metadata as Record<string, unknown>)
                    : {}),
                  actorLabel: participant.label,
                  projectName: participant.project_name
                }
              }),
              event.id
            )
          }
        }
        const archivedAt = Date.now()
        this.db
          .prepare(
            `UPDATE collaboration_groups SET status = 'archived', updated_at = ?
             WHERE id IN (${placeholders})`
          )
          .run(archivedAt, ...groupIds)
        this.db
          .prepare(
            `UPDATE collaboration_missions
             SET status = 'stopped', updated_at = ?, completed_at = COALESCE(completed_at, ?)
             WHERE group_id IN (${placeholders}) AND status = 'paused'`
          )
          .run(archivedAt, archivedAt, ...groupIds)
        this.db
          .prepare(
            `UPDATE collaboration_participants
             SET status = 'removed', removed_at = COALESCE(removed_at, ?)
             WHERE group_id IN (${placeholders})`
          )
          .run(archivedAt, ...groupIds)
        this.db.prepare('DELETE FROM collaboration_participants WHERE project_id = ?').run(id)
      }

      const standalone = this.listConversationPlacement(null)
      const now = Date.now()
      for (const conversation of projectConversations) {
        this.db
          .prepare(
            `UPDATE conversations
             SET project_id = NULL,
                 project_context_version = project_context_version + 1,
                 home_workspace_root = COALESCE(home_workspace_root, ?),
                 home_project_name = COALESCE(home_project_name, ?)
             WHERE id = ?`
          )
          .run(project.folder_path, project.name, conversation.id)
        this.insertTransition({
          id: randomUUID(),
          conversationId: conversation.id,
          fromProjectId: project.id,
          toProjectId: null,
          fromProjectName: project.name,
          toProjectName: null,
          fromWorkspaceRoot: project.folder_path,
          toWorkspaceRoot: null,
          movedAt: now
        })
      }
      this.rewriteOrder(
        null,
        [...projectConversations, ...standalone].map(({ id: conversationId }) => conversationId)
      )
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })()
  }

  private listConversationPlacement(projectId: string | null): ProjectConversation[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE project_id IS ?
         ORDER BY sidebar_order ASC, updated_at DESC, created_at DESC`
      )
      .all(projectId) as ProjectConversation[]
  }

  private rewriteOrder(projectId: string | null, conversationIds: string[]): void {
    const update = this.db.prepare(
      'UPDATE conversations SET sidebar_order = ? WHERE id = ? AND project_id IS ?'
    )
    conversationIds.forEach((conversationId, index) => update.run(index, conversationId, projectId))
  }

  private hasActiveRun(conversationId: string): boolean {
    const activePhases = [
      'queued',
      'streaming',
      'awaiting_permission',
      'awaiting_user',
      'executing_tool',
      'compacting',
      'stopping'
    ] as const
    const placeholders = activePhases.map(() => '?').join(', ')
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM agent_runs
           WHERE thread_id = ? AND phase IN (${placeholders})
           LIMIT 1`
        )
        .get(conversationId, ...activePhases)
    )
  }

  private insertTransition(transition: ConversationProjectTransition): void {
    this.db
      .prepare(
        `INSERT INTO conversation_project_events
         (id, conversation_id, from_project_id, to_project_id,
          from_project_name, to_project_name, from_workspace_root, to_workspace_root, moved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        transition.id,
        transition.conversationId,
        transition.fromProjectId,
        transition.toProjectId,
        transition.fromProjectName,
        transition.toProjectName,
        transition.fromWorkspaceRoot,
        transition.toWorkspaceRoot,
        transition.movedAt
      )
  }
}
