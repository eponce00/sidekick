import { registerWindowHandlers } from './window'
import { registerSettingsHandlers } from './settings'
import { registerDatabaseHandlers } from './database'
import { registerWorkspaceHandlers } from './workspace'
import { registerCheckpointHandlers } from './checkpointHandlers'
import { registerMcpHandlers } from './mcp'
import { registerPermissionHandlers } from './permissions'
import { registerProjectHandlers } from './projects'
import { registerProviderRuntimeHandlers } from './providerRuntime'
import { registerCollaborationHandlers } from './collaboration'
import { registerAgentRunHandlers } from './agentRuns'
import { registerSessionStatusHandlers } from './sessionStatus'
import { registerSupportHandlers } from './support'
import { registerSiteIconHandlers } from './siteIcons'
import { registerBrowserNetworkHandlers } from './browserNetwork'
import { registerScheduleHandlers } from './schedules'
import { registerPullRequestHandlers } from './pullRequests'
import { registerWorktreeHandlers } from './worktrees'

/**
 * Registers all IPC handlers. Call after store and db are initialized.
 */
export function registerAllHandlers(): void {
  registerWindowHandlers()
  registerSiteIconHandlers()
  registerProviderRuntimeHandlers()
  registerSettingsHandlers()
  registerDatabaseHandlers()
  registerProjectHandlers()
  registerWorktreeHandlers()
  registerWorkspaceHandlers()
  registerCheckpointHandlers()
  registerMcpHandlers()
  registerPermissionHandlers()
  registerBrowserNetworkHandlers()
  registerPullRequestHandlers()
  registerSupportHandlers()
  registerCollaborationHandlers()
  registerAgentRunHandlers()
  registerSessionStatusHandlers()
  registerScheduleHandlers()
}
