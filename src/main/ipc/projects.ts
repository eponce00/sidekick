import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, resolve } from 'path'
import { getDb } from './state'
import { ProjectStore } from '../services/projectStore'
import { assertNotAppFolder, assertPickedFolder } from './workspaceUtils'
import type { MoveConversationInput, UpdateProjectFoldersInput } from '../../shared/projects'

async function normalizeProjectFolder(folderPath: string): Promise<string> {
  const normalized = resolve(folderPath)
  const stat = await fs.stat(normalized)
  if (!stat.isDirectory()) throw new Error('Project folder must be a directory')
  return normalized
}

export function registerProjectHandlers(): void {
  const store = new ProjectStore(getDb())

  ipcMain.handle('projects:list', async () => store.list())

  // A project folder becomes a trusted workspace, so only one the user picked can become one.
  ipcMain.handle('projects:create', async (_, folderPath: string, name?: string) => {
    assertPickedFolder(folderPath)
    const normalizedPath = await normalizeProjectFolder(folderPath)
    return store.create(normalizedPath, name?.trim() || basename(normalizedPath) || normalizedPath)
  })

  ipcMain.handle(
    'projects:update',
    async (_, id: string, input: { name?: string; isPinned?: boolean }) => store.update(id, input)
  )

  // Every folder of a project is trusted like its primary one, so each must be one the user picked.
  ipcMain.handle('projects:updateFolders', async (_, raw: unknown) => {
    const input = raw as UpdateProjectFoldersInput
    const names = (value: unknown): value is string[] | undefined =>
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= 50 &&
        value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4_096))
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.projectId !== 'string' ||
      !input.projectId ||
      input.projectId.length > 100 ||
      !names(input.add) ||
      !names(input.remove) ||
      (input.makePrimary !== undefined &&
        (typeof input.makePrimary !== 'string' || input.makePrimary.length > 4_096))
    ) {
      throw new Error('Invalid project folder change')
    }
    const project = store.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const add: Array<{ path: string }> = []
    for (const folderPath of input.add ?? []) {
      assertPickedFolder(folderPath)
      assertNotAppFolder(folderPath)
      add.push({ path: await normalizeProjectFolder(folderPath) })
    }
    // A name that matches a folder at the top of the primary folder would hide it from the agent.
    const reservedNames = add.length
      ? await fs.readdir(project.folder_path).catch(() => [] as string[])
      : []
    return store.updateFolders({
      projectId: project.id,
      add: add.map((folder) => ({ ...folder, reservedNames })),
      remove: input.remove,
      makePrimary: input.makePrimary
    })
  })

  ipcMain.handle('projects:remove', async (_, id: string) => {
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
