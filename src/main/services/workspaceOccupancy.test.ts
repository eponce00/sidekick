import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseWorkspaceBusyMessage, workspaceBusyDisplayMessage } from '../../shared/worktrees'
import { WorkspaceOccupancy } from './workspaceOccupancy'

describe('WorkspaceOccupancy', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidekick-occupancy-'))
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await mkdir(join(root, '..', `${root.split(/[\\/]/).at(-1)}-sibling`), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}-sibling`, { recursive: true, force: true })
  })

  const occupant = (runId: string, conversationId: string, workspaceRoot: string) => ({
    runId,
    conversationId,
    title: `Chat ${conversationId}`,
    workspaceRoot
  })

  it('refuses a second writer in the same, a containing or a nested folder', () => {
    const occupancy = new WorkspaceOccupancy()
    occupancy.admit(occupant('run-a', 'a', root))
    for (const folder of [root, join(root, 'packages', 'app'), join(root, '..')]) {
      let message = ''
      try {
        occupancy.admit(occupant(`run-${folder}`, 'b', folder))
      } catch (error) {
        message = (error as Error).message
      }
      expect(parseWorkspaceBusyMessage(message)).toEqual([occupant('run-a', 'a', root)])
      expect(workspaceBusyDisplayMessage(message)).toContain('“Chat a”')
      expect(workspaceBusyDisplayMessage(message)).not.toContain('[workspace-busy]')
    }
  })

  it('lets unrelated folders, the same chat and an explicit share through', () => {
    const occupancy = new WorkspaceOccupancy()
    occupancy.admit(occupant('run-a', 'a', root))
    expect(() => occupancy.admit(occupant('run-b', 'b', `${root}-sibling`))).not.toThrow()
    expect(() => occupancy.admit(occupant('run-a2', 'a', root))).not.toThrow()
    expect(() => occupancy.admit(occupant('run-c', 'c', root), 'allow')).not.toThrow()
    expect(occupancy.occupants(root, 'd').map(({ runId }) => runId)).toEqual([
      'run-a',
      'run-a2',
      'run-c'
    ])
  })

  it('frees the folder when a run releases it', () => {
    const occupancy = new WorkspaceOccupancy()
    const release = occupancy.admit(occupant('run-a', 'a', root))
    release()
    release()
    expect(() => occupancy.admit(occupant('run-b', 'b', root))).not.toThrow()
  })

  it('compares folder names the way the platform does', () => {
    const occupancy = new WorkspaceOccupancy()
    occupancy.admit(occupant('run-a', 'a', root))
    const differentCase = root.toUpperCase()
    expect(occupancy.occupants(differentCase, 'b').length).toBe(
      process.platform === 'win32' || process.platform === 'darwin' ? 1 : 0
    )
  })
})
