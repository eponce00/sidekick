import { beforeEach, describe, expect, it, vi } from 'vitest'

type RegisteredHandler = (...args: unknown[]) => unknown

const { handlers, readStatus, resolveKnownWorkspace } = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
  readStatus: vi.fn(async () => ({ ok: true, status: null })),
  resolveKnownWorkspace: vi.fn((root: string) => {
    if (root !== 'C:\\Projects\\sidekick') {
      throw new Error('Workspace is not associated with a SideKick project chat')
    }
    return root
  })
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => handlers.set(channel, handler))
  }
}))
vi.mock('./workspaceUtils', () => ({ resolveKnownWorkspace }))
vi.mock('../services/pullRequestStatus', () => ({
  createPullRequestStatusReader: () => readStatus
}))

import { registerPullRequestHandlers } from './pullRequests'

describe('pull request IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPullRequestHandlers()
  })

  const getStatus = (root: unknown) => handlers.get('pullRequests:getStatus')?.({}, root)

  it('reads the status of a folder that belongs to a SideKick chat', async () => {
    await expect(getStatus('C:\\Projects\\sidekick')).resolves.toEqual({ ok: true, status: null })
    expect(readStatus).toHaveBeenCalledWith('C:\\Projects\\sidekick')
  })

  it.each([
    ['an unknown folder', 'C:\\Windows\\System32'],
    ['an empty root', ''],
    ['a missing root', undefined],
    ['a command instead of a folder', ['gh', 'pr', 'merge']],
    ['an object', { cwd: 'C:\\Projects\\sidekick', args: ['pr', 'create'] }]
  ])('refuses %s without running git or gh', async (_name, root) => {
    const result = (await getStatus(root)) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(readStatus).not.toHaveBeenCalled()
  })
})
