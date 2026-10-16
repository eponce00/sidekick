import { app, ipcMain, shell } from 'electron'
import { stat } from 'fs/promises'
import { join } from 'path'
import { getDb } from './state'
import { ManagedWorktreeService } from '../services/managedWorktreeService'
import { ProjectStore } from '../services/projectStore'
import { setupCreatedWorktree } from './worktreeSetup'
import type {
  CreateConversationWorktreeInput,
  RemoveManagedWorktreeInput
} from '../../shared/worktrees'

let service: ManagedWorktreeService | null = null

/**
 * The one managed-worktree service. Main-process callers (forks, schedules, agent-started chats)
 * use it directly; the renderer reaches it only through the handlers below, by identity.
 */
export function getManagedWorktrees(): ManagedWorktreeService {
  service ??= new ManagedWorktreeService(getDb(), join(app.getPath('userData'), 'worktrees'))
  return service
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

export function registerWorktreeHandlers(): void {
  const worktrees = getManagedWorktrees()

  ipcMain.handle('worktrees:list', () => worktrees.list())

  ipcMain.handle('worktrees:diskUsage', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid worktree')
    return worktrees.diskUsage(id)
  })

  ipcMain.handle('worktrees:branchOptions', (_event, projectId: unknown) => {
    if (!validId(projectId)) throw new Error('Invalid project')
    return worktrees.branchOptions(projectId)
  })

  ipcMain.handle('worktrees:createForConversation', async (event, raw: unknown) => {
    const input = raw as CreateConversationWorktreeInput
    if (
      !input ||
      typeof input !== 'object' ||
      !validId(input.conversationId) ||
      !optionalText(input.branchName, 200) ||
      !optionalText(input.baseRef, 200)
    )
      throw new Error('Invalid worktree request')
    const result = await worktrees.createForConversation({
      conversationId: input.conversationId,
      ...(input.branchName ? { branchName: input.branchName } : {}),
      ...(input.baseRef ? { baseRef: input.baseRef } : {})
    })
    // Setup hooks match the original project's folder, also for a worktree started from a worktree.
    const source = new ProjectStore(getDb()).get(result.worktree.sourceProjectId)
    if (source) {
      // Setup finishes, or is skipped, before the first run uses the folder. The chat has
      // already moved, so setup denial or failure never undoes it.
      await setupCreatedWorktree(
        event.sender,
        source.folder_path,
        result.project.folder_path
      ).catch(() =>
        console.warn('[Worktrees] Setup could not finish; the new worktree is preserved')
      )
    }
    return result
  })

  ipcMain.handle('worktrees:remove', (_event, raw: unknown) => {
    const input = raw as RemoveManagedWorktreeInput
    if (
      !input ||
      typeof input !== 'object' ||
      !validId(input.id) ||
      (input.force !== undefined && typeof input.force !== 'boolean') ||
      (input.deleteBranch !== undefined && typeof input.deleteBranch !== 'boolean') ||
      (input.deleteBranch && !input.force)
    )
      throw new Error('Invalid worktree removal')
    return worktrees.remove({
      id: input.id,
      force: input.force === true,
      deleteBranch: input.deleteBranch === true
    })
  })

  ipcMain.handle('worktrees:sync', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid worktree')
    return worktrees.syncWithBase(id)
  })

  // Opens SideKick's own folder for this worktree, never a renderer-chosen path.
  ipcMain.handle('worktrees:reveal', async (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid worktree')
    const { worktreeRoot } = await worktrees.get(id)
    if (
      !(await stat(worktreeRoot).then(
        (entry) => entry.isDirectory(),
        () => false
      ))
    )
      throw new Error('The worktree folder no longer exists')
    const error = await shell.openPath(worktreeRoot)
    if (error) throw new Error(error)
  })
}
