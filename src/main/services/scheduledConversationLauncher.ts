import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import { conversationTitleVersionForSource } from '../../shared/conversationTitles'
import type { PinnedModel } from '../../shared/models'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import type { Schedule } from '../../shared/schedules'
import type { WorkspaceOccupant } from '../../shared/worktrees'
import type { ScheduledRunLauncher, ScheduledRunPlacement } from './scheduleService'

export interface ScheduledConversationLauncherOptions {
  db: Database.Database
  settings: () => ProviderSettings
  /** The same entry point the renderer's chat uses, so permissions and tools are identical. */
  startConversationRun: (input: StartConversationAgentRunInput) => Promise<unknown>
  /** Agents writing in this folder, or one inside or around it. */
  folderOccupants?: (folder: string) => WorkspaceOccupant[]
  isRunQueued?: (agentRunId: string) => boolean
  worktrees?: {
    isGitProject: (projectId: string) => Promise<boolean>
    /** A new worktree project of `projectId`, and where it starts ("detached from main"). */
    create: (projectId: string, title: string) => Promise<{ projectId: string; location: string }>
    discard: (projectId: string) => Promise<void>
  }
  now?: () => number
}

/**
 * A scheduled run never writes into a folder where another agent is writing: it starts in a new
 * worktree when the project is a Git repository, and is skipped otherwise.
 */
async function placeScheduledRun(
  options: ScheduledConversationLauncherOptions,
  schedule: Schedule
): Promise<ScheduledRunPlacement> {
  if (!schedule.projectId) return { projectId: null }
  const project = options.db
    .prepare('SELECT folder_path FROM projects WHERE id = ?')
    .get(schedule.projectId) as { folder_path: string } | undefined
  const occupants = project ? (options.folderOccupants?.(project.folder_path) ?? []) : []
  if (!occupants.length) return { projectId: schedule.projectId }
  const names = occupants.map(({ title }) => `“${title}”`).join(', ')
  const who = occupants.length === 1 ? `${names} was` : `${names} were`
  if (!options.worktrees || !(await options.worktrees.isGitProject(schedule.projectId))) {
    return {
      skip: `Skipped: ${who} working in the project folder, and it is not a Git repository, so the run could not start in a separate worktree.`
    }
  }
  const worktrees = options.worktrees
  const created = await worktrees.create(schedule.projectId, schedule.name)
  return {
    projectId: created.projectId,
    note: `Started in a new worktree, ${created.location}, because ${who} working in the project folder.`,
    discard: () => worktrees.discard(created.projectId)
  }
}

export function createScheduledConversationLauncher(
  options: ScheduledConversationLauncherOptions
): ScheduledRunLauncher {
  const { db } = options
  const now = options.now ?? Date.now
  return {
    resolveModel: (modelId: string): PinnedModel | null =>
      pinnedModelsFromProviderInstances(options.settings().providerInstances ?? []).find(
        ({ id }) => id === modelId
      ) ?? null,
    projectExists: (projectId: string): boolean =>
      Boolean(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)),
    placeRun: (schedule) => placeScheduledRun(options, schedule),
    ...(options.isRunQueued ? { isRunQueued: options.isRunQueued } : {}),
    createConversation: (schedule: Schedule, runNumber: number, projectId: string | null): string =>
      db.transaction(() => {
        const id = randomUUID()
        const timestamp = now()
        const project = projectId
          ? (db.prepare('SELECT name, folder_path FROM projects WHERE id = ?').get(projectId) as
              | { name: string; folder_path: string }
              | undefined)
          : undefined
        if (projectId && !project) throw new Error('Project not found')
        const placement = db
          .prepare(
            `SELECT COALESCE(MIN(sidebar_order), 0) - 1 AS sidebar_order
             FROM conversations WHERE project_id IS ?`
          )
          .get(projectId) as { sidebar_order: number }
        // The schedule names its chats; a generated title would hide which run this is. The chat
        // keeps the schedule's permission ceiling, and the chats it starts inherit it.
        db.prepare(
          `INSERT INTO conversations
           (id, title, created_at, updated_at, project_id, title_source, title_version,
            sidebar_order, project_context_version, home_workspace_root, home_project_name,
            schedule_id, schedule_run_number, started_by_kind, permission_ceiling)
           VALUES (?, ?, ?, ?, ?, 'preserved', ?, ?, 0, ?, ?, ?, ?, 'schedule', ?)`
        ).run(
          id,
          `${schedule.name} · Run ${runNumber}`,
          timestamp,
          timestamp,
          projectId,
          conversationTitleVersionForSource('preserved'),
          placement.sidebar_order,
          project?.folder_path ?? null,
          project?.name ?? null,
          schedule.id,
          runNumber,
          schedule.permissionCeiling ?? null
        )
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, run_mode, timestamp)
           VALUES (?, ?, 'user', ?, 'conversation', ?)`
        ).run(randomUUID(), id, schedule.prompt, timestamp)
        return id
      })(),
    start: async ({ conversationId, agentRunId, model }): Promise<void> => {
      await options.startConversationRun({
        id: agentRunId,
        conversationId,
        assistantMessageId: randomUUID(),
        model,
        mode: 'conversation'
      })
    },
    reportFailure: (conversationId: string, message: string): void => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, notice_tone, timestamp)
         VALUES (?, ?, 'system', ?, 'error', ?)`
      ).run(randomUUID(), conversationId, message, now())
    }
  }
}
