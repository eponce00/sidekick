import { randomUUID } from 'crypto'
import { basename, isAbsolute, relative, resolve, sep } from 'path'
import Database from 'better-sqlite3'
import type {
  ConversationProjectContext,
  ConversationProjectTransition,
  MoveConversationInput,
  MoveConversationResult,
  Project,
  ProjectConversation,
  WorkspaceFolder
} from '../../shared/projects'
import { chatFolderPath } from './chatFolders'
import { workspacePathKey } from '../utils/workspacePaths'

/** One folder is the other, or inside it. */
export function foldersOverlap(left: string, right: string): boolean {
  const inside = (child: string, parent: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }
  return inside(resolve(left), resolve(right)) || inside(resolve(right), resolve(left))
}

/**
 * A short name for a folder, unique among the names taken: its own name, or that name with a
 * number. The agent writes it as a path's first segment, so it must be one valid segment.
 */
export function folderNameFor(folderPath: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(workspacePathKey))
  const base =
    basename(resolve(folderPath))
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
      .replace(/^\.+/, '')
      .trim() || 'folder'
  let name = base
  for (let number = 2; used.has(workspacePathKey(name)); number++) name = `${base}-${number}`
  return name
}

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
    const folders = this.allFolders()
    const projects = this.db
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
    return projects.map((project) => ({ ...project, folders: folders.get(project.id) ?? [] }))
  }

  get(id: string): Project | undefined {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Project
      | undefined
    return project && { ...project, folders: this.folders(id) }
  }

  /** The project's extra folders, in the order they were added. */
  folders(projectId: string): WorkspaceFolder[] {
    return this.db
      .prepare(
        `SELECT name, folder_path AS path FROM project_folders
         WHERE project_id = ? ORDER BY position ASC, added_at ASC`
      )
      .all(projectId) as WorkspaceFolder[]
  }

  private allFolders(): Map<string, WorkspaceFolder[]> {
    const rows = this.db
      .prepare(
        `SELECT project_id, name, folder_path AS path FROM project_folders
         ORDER BY position ASC, added_at ASC`
      )
      .all() as Array<WorkspaceFolder & { project_id: string }>
    const byProject = new Map<string, WorkspaceFolder[]>()
    for (const { project_id, ...folder } of rows) {
      byProject.set(project_id, [...(byProject.get(project_id) ?? []), folder])
    }
    return byProject
  }

  /**
   * The extra folders that go with a workspace root: a project's, for its primary folder. A chat's
   * worktree copies one repository, so a project folder inside that repository is the worktree's
   * copy of it, and every other folder goes with the chat as it is (the primary too, when it is
   * another repository). Any other root has none.
   */
  foldersForRoot(workspaceRoot: string): WorkspaceFolder[] {
    const root = resolve(workspaceRoot)
    const project = this.db.prepare('SELECT id FROM projects WHERE folder_path = ?').get(root) as
      | { id: string }
      | undefined
    if (project) return this.folders(project.id)
    const worktree = this.db
      .prepare(
        `SELECT w.repository_root, w.worktree_root, p.id, p.folder_path FROM managed_worktrees w
         JOIN projects p ON p.id = w.source_project_id
         WHERE w.folder_path = ?`
      )
      .get(root) as
      | { repository_root: string; worktree_root: string; id: string; folder_path: string }
      | undefined
    if (!worktree) return []
    const extras = this.folders(worktree.id)
    const primary: WorkspaceFolder = {
      name: folderNameFor(
        worktree.folder_path,
        extras.map(({ name }) => name)
      ),
      path: worktree.folder_path
    }
    const repository = resolve(worktree.repository_root)
    return [primary, ...extras].flatMap((folder) => {
      const inRepository = relative(repository, resolve(folder.path))
      if (inRepository === '..' || inRepository.startsWith(`..${sep}`) || isAbsolute(inRepository))
        return [folder]
      const copy = resolve(worktree.worktree_root, inRepository)
      return workspacePathKey(copy) === workspacePathKey(root) ? [] : [{ ...folder, path: copy }]
    })
  }

  /**
   * Adds folders (the caller has checked each is a directory the user picked), removes extra
   * folders by name, and makes an extra folder the primary one. A folder inside another of the
   * project's folders is refused: a path in it would belong to both.
   */
  updateFolders(input: {
    projectId: string
    add?: Array<{ path: string; reservedNames?: string[] }>
    remove?: string[]
    makePrimary?: string
  }): Project {
    return this.db.transaction(() => {
      const project = this.get(input.projectId)
      if (!project) throw new Error('Project not found')
      if (
        (input.remove?.length || input.makePrimary) &&
        this.listConversationPlacement(project.id).some(({ id }) => this.hasActiveRun(id))
      ) {
        throw new Error("Stop the project's active runs before removing or swapping its folders")
      }
      const now = Date.now()
      for (const name of input.remove ?? []) {
        this.db
          .prepare('DELETE FROM project_folders WHERE project_id = ? AND name = ?')
          .run(project.id, name)
      }
      for (const { path, reservedNames = [] } of input.add ?? []) {
        const folderPath = resolve(path)
        const current = this.get(project.id)!
        const existing = [current.folder_path, ...current.folders!.map((folder) => folder.path)]
        if (
          existing.some(
            (other) => workspacePathKey(resolve(other)) === workspacePathKey(folderPath)
          )
        )
          continue
        if (existing.some((other) => foldersOverlap(other, folderPath))) {
          throw new Error(
            `${folderPath} is inside one of the project's folders, or contains one. Add folders that sit side by side.`
          )
        }
        const name = folderNameFor(folderPath, [
          ...current.folders!.map((folder) => folder.name),
          ...reservedNames
        ])
        const { last } = this.db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) AS last FROM project_folders WHERE project_id = ?'
          )
          .get(project.id) as { last: number }
        this.db
          .prepare(
            `INSERT INTO project_folders (project_id, name, folder_path, position, added_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(project.id, name, folderPath, last + 1, now)
      }
      if (input.makePrimary) this.makePrimary(project.id, input.makePrimary, now)
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project.id)
      return this.get(project.id)!
    })()
  }

  /**
   * Swaps the primary folder with an extra one, which takes the old primary's place in the list.
   * The project's chats and memory follow the project, not the folder.
   */
  private makePrimary(projectId: string, name: string, now: number): void {
    const project = this.get(projectId)!
    const chosen = project.folders!.find((folder) => folder.name === name)
    if (!chosen) throw new Error(`The project has no folder named ${name}`)
    if (
      this.db
        .prepare('SELECT 1 FROM projects WHERE folder_path = ? AND id <> ?')
        .get(chosen.path, projectId)
    ) {
      throw new Error(`${chosen.path} is already the main folder of another project`)
    }
    const { position } = this.db
      .prepare('SELECT position FROM project_folders WHERE project_id = ? AND name = ?')
      .get(projectId, name) as { position: number }
    this.db
      .prepare('DELETE FROM project_folders WHERE project_id = ? AND name = ?')
      .run(projectId, name)
    const formerName = folderNameFor(
      project.folder_path,
      project.folders!.filter((folder) => folder.name !== name).map((folder) => folder.name)
    )
    this.db
      .prepare(
        `INSERT INTO project_folders (project_id, name, folder_path, position, added_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(projectId, formerName, project.folder_path, position, now)
    this.db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(chosen.path, projectId)
    // A detached chat finds its way back to its project by the primary folder.
    this.db
      .prepare('UPDATE conversations SET home_workspace_root = ? WHERE home_workspace_root = ?')
      .run(chosen.path, project.folder_path)
    // Memory is the project's, so it moves to the new primary unless that folder has its own.
    this.db
      .prepare(
        `UPDATE workspace_memory SET workspace_path = ?
         WHERE workspace_path = ?
           AND NOT EXISTS (SELECT 1 FROM workspace_memory WHERE workspace_path = ?)`
      )
      .run(chosen.path, project.folder_path, chosen.path)
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
                c.home_workspace_root, c.home_project_name, c.worktree_id,
                p.name, p.folder_path, w.folder_path AS worktree_folder,
                w.branch AS worktree_branch,
                w.base_ref AS worktree_base
         FROM conversations c
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN managed_worktrees w ON w.id = c.worktree_id
         WHERE c.id = ?`
      )
      .get(conversationId) as
      | {
          id: string
          project_id: string | null
          project_context_version: number
          home_workspace_root: string | null
          home_project_name: string | null
          worktree_id: string | null
          name: string | null
          folder_path: string | null
          worktree_folder: string | null
          worktree_branch: string | null
          worktree_base: string | null
        }
      | undefined
    if (!conversation) throw new Error('Conversation not found')
    const inWorktree = Boolean(conversation.worktree_id && conversation.worktree_folder)
    const projectRoot = conversation.worktree_folder ?? conversation.folder_path
    // A chat with no project, never attached or detached from one, works in a folder of its own.
    const chatFolder = projectRoot ? null : chatFolderPath(conversationId)

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
      // A chat in its own worktree works there, even if its project was removed since.
      workspaceRoot: projectRoot ?? chatFolder,
      folders: projectRoot ? this.foldersForRoot(projectRoot) : [],
      ...(chatFolder ? { chatFolder: true } : {}),
      worktreeId: inWorktree ? conversation.worktree_id : null,
      worktree: inWorktree
        ? {
            projectFolder: conversation.folder_path,
            branch: conversation.worktree_branch,
            base: conversation.worktree_base
          }
        : null,
      homeWorkspaceRoot: conversation.home_workspace_root,
      homeProjectName: conversation.home_project_name,
      isDetached:
        !conversation.project_id &&
        !conversation.worktree_folder &&
        Boolean(conversation.home_workspace_root),
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
        current.home_workspace_root !== destination.folder_path &&
        // The project's primary folder may have changed since the chat left it.
        !destination.folders?.some(({ path }) => path === current.home_workspace_root)
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

  hasActiveRun(conversationId: string): boolean {
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
