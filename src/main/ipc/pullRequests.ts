import { ipcMain } from 'electron'
import { createPullRequestStatusReader } from '../services/pullRequestStatus'
import { resolveKnownWorkspace } from './workspaceUtils'
import type { PullRequestStatusResult } from '../../shared/pullRequests'

const readPullRequestStatus = createPullRequestStatusReader()

export function registerPullRequestHandlers(): void {
  // The renderer names a folder, never a command; the folder must belong to a SideKick chat.
  ipcMain.handle(
    'pullRequests:getStatus',
    async (_event, passedRoot: unknown): Promise<PullRequestStatusResult> => {
      if (typeof passedRoot !== 'string' || !passedRoot) {
        return { ok: false, error: 'A workspace folder is required' }
      }
      let workspaceRoot: string
      try {
        workspaceRoot = resolveKnownWorkspace(passedRoot)
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
      return readPullRequestStatus(workspaceRoot)
    }
  )
}
