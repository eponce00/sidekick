import { app, ipcMain, shell } from 'electron'
import { stat } from 'fs/promises'
import { join } from 'path'
import { getDb } from './state'
import { ManagedWorktreeService } from '../services/managedWorktreeService'
import type {
  CreateConversationWorktreeInput,
  CreateConversationWorktreeResult
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

/** Moves a chat into its own worktree of its project. */
export async function createChatWorktree(
  input: CreateConversationWorktreeInput
): Promise<CreateConversationWorktreeResult> {
  return getManagedWorktrees().createForConversation({
    conversationId: input.conversationId,
    ...(input.baseRef ? { baseRef: input.baseRef } : {})
  })
}

export function registerWorktreeHandlers(): void {
  const worktrees = getManagedWorktrees()

  ipcMain.handle('worktrees:list', () => worktrees.list())

  ipcMain.handle('worktrees:branchOptions', (_event, projectId: unknown) => {
    if (!validId(projectId)) throw new Error('Invalid project')
    return worktrees.branchOptions(projectId)
  })

  ipcMain.handle('worktrees:createForConversation', async (_event, raw: unknown) => {
    const input = raw as CreateConversationWorktreeInput
    if (
      !input ||
      typeof input !== 'object' ||
      !validId(input.conversationId) ||
      !optionalText(input.baseRef, 200)
    )
      throw new Error('Invalid worktree request')
    return createChatWorktree(input)
  })

  ipcMain.handle('worktrees:remove', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Invalid worktree')
    return worktrees.remove(id)
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
      throw new Error('This worktree is set aside. Send a message in its chat to bring it back.')
    const error = await shell.openPath(worktreeRoot)
    if (error) throw new Error(error)
  })
}
