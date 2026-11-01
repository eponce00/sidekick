import Database from 'better-sqlite3'
import { mkdir, mkdtemp, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: { db: null as Database.Database | null }
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/Applications/SideKick.app' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('./state', () => ({
  getDb: () => state.db,
  getStore: () => ({ get: () => null, set: () => undefined })
}))

import { applyDatabaseSchema } from '../bootstrap/database'
import { registerProjectHandlers } from './projects'
import { rememberPickedFolder, resolveKnownWorkspace } from './workspaceUtils'

describe('project folders over IPC', () => {
  let parent: string

  beforeEach(async () => {
    parent = await realpath(await mkdtemp(join(tmpdir(), 'sidekick-project-folders-')))
    for (const folder of ['app', 'api', 'never-picked']) await mkdir(join(parent, folder))
    state.db = new Database(':memory:')
    applyDatabaseSchema(state.db)
    handlers.clear()
    registerProjectHandlers()
  })

  afterEach(async () => {
    state.db?.close()
    await rm(parent, { recursive: true, force: true })
  })

  const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)

  it('adds only folders the user picked, and trusts each one it added as a workspace', async () => {
    rememberPickedFolder(join(parent, 'app'))
    rememberPickedFolder(join(parent, 'api'))
    const project = (await call('projects:create', join(parent, 'app'))) as { id: string }

    // A renderer can name any path; only one chosen in the folder picker becomes trusted.
    await expect(
      call('projects:updateFolders', { projectId: project.id, add: [join(parent, 'never-picked')] })
    ).rejects.toThrow('folder picker')
    expect(() => resolveKnownWorkspace(join(parent, 'never-picked'))).toThrow()

    await call('projects:updateFolders', { projectId: project.id, add: [join(parent, 'api')] })
    expect(resolveKnownWorkspace(join(parent, 'api'))).toBe(join(parent, 'api'))

    await call('projects:updateFolders', { projectId: project.id, remove: ['api'] })
    expect(() => resolveKnownWorkspace(join(parent, 'api'))).toThrow()
  })
})
