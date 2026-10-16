import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import { conversationTitleVersionForSource } from '../../shared/conversationTitles'
import type { PinnedModel } from '../../shared/models'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import type { Schedule } from '../../shared/schedules'
import type { ScheduledRunLauncher } from './scheduleService'

export interface ScheduledConversationLauncherOptions {
  db: Database.Database
  settings: () => ProviderSettings
  /** The same entry point the renderer's chat uses, so permissions and tools are identical. */
  startConversationRun: (input: StartConversationAgentRunInput) => Promise<unknown>
  now?: () => number
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
    createConversation: (schedule: Schedule, runNumber: number): string =>
      db.transaction(() => {
        const id = randomUUID()
        const timestamp = now()
        const project = schedule.projectId
          ? (db
              .prepare('SELECT name, folder_path FROM projects WHERE id = ?')
              .get(schedule.projectId) as { name: string; folder_path: string } | undefined)
          : undefined
        if (schedule.projectId && !project) throw new Error('Project not found')
        const placement = db
          .prepare(
            `SELECT COALESCE(MIN(sidebar_order), 0) - 1 AS sidebar_order
             FROM conversations WHERE project_id IS ?`
          )
          .get(schedule.projectId) as { sidebar_order: number }
        // The schedule names its chats; a generated title would hide which run this is.
        db.prepare(
          `INSERT INTO conversations
           (id, title, created_at, updated_at, project_id, title_source, title_version,
            sidebar_order, project_context_version, home_workspace_root, home_project_name,
            schedule_id, schedule_run_number)
           VALUES (?, ?, ?, ?, ?, 'preserved', ?, ?, 0, ?, ?, ?, ?)`
        ).run(
          id,
          `${schedule.name} · Run ${runNumber}`,
          timestamp,
          timestamp,
          schedule.projectId,
          conversationTitleVersionForSource('preserved'),
          placement.sidebar_order,
          project?.folder_path ?? null,
          project?.name ?? null,
          schedule.id,
          runNumber
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
