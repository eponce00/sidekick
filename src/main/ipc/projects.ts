import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, resolve } from 'path'
import { getDb } from './state'
import { ProjectStore } from '../services/projectStore'
import type { MoveConversationInput } from '../../shared/projects'
import { getManagedWorktrees } from './worktrees'

async function normalizeProjectFolder(folderPath: string): Promise<string> {
  const normalized = resolve(folderPath)
  const stat = await fs.stat(normalized)
  if (!stat.isDirectory()) throw new Error('Project folder must be a directory')
  return normalized
}

export function registerProjectHandlers(): void {
  const store = new ProjectStore(getDb())

  ipcMain.handle('projects:list', async () => store.list())

  ipcMain.handle('projects:create', async (_, folderPath: string, name?: string) => {
    const normalizedPath = await normalizeProjectFolder(folderPath)
    return store.create(normalizedPath, name?.trim() || basename(normalizedPath) || normalizedPath)
  })

  ipcMain.handle(
    'projects:update',
    async (_, id: string, input: { name?: string; isPinned?: boolean }) => store.update(id, input)
  )

  ipcMain.handle('projects:remove', async (_, id: string) => {
    // A SideKick worktree is removed as a worktree, so its folder and branch are not orphaned.
    const worktrees = getManagedWorktrees()
    if (typeof id === 'string' && worktrees.isManagedProject(id)) {
      const worktree = (await worktrees.list()).find(({ projectId }) => projectId === id)
      const result = worktree ? await worktrees.remove(worktree.id) : { removed: true }
      if (!result.removed) throw new Error(`This worktree was kept. ${result.reason ?? ''}`.trim())
      return { success: true }
    }
    store.remove(id)
    return { success: true }
  })

  ipcMain.handle('projects:getConversationContext', async (_, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 100) {
      throw new Error('Invalid conversation ID')
    }
    return store.getConversationContext(conversationId)
  })

  ipcMain.handle('projects:moveConversation', async (_, input: MoveConversationInput) => {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.conversationId !== 'string' ||
      !input.conversationId ||
      input.conversationId.length > 100 ||
      (input.projectId !== null && typeof input.projectId !== 'string') ||
      (input.anchorConversationId != null && typeof input.anchorConversationId !== 'string') ||
      (input.placement != null && !['before', 'after', 'start', 'end'].includes(input.placement)) ||
      (input.expectedProjectContextVersion != null &&
        (!Number.isInteger(input.expectedProjectContextVersion) ||
          input.expectedProjectContextVersion < 0))
    ) {
      throw new Error('Invalid conversation move')
    }
    return store.moveConversation(input)
  })
}
