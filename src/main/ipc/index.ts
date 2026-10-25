import { registerWindowHandlers } from './window'
import { registerSettingsHandlers } from './settings'
import { registerDatabaseHandlers } from './database'
import { registerConversationModelHandlers } from './conversationModels'
import { registerWorkspaceHandlers } from './workspace'
import { registerCheckpointHandlers } from './checkpointHandlers'
import { registerMcpHandlers } from './mcp'
import { registerPermissionHandlers } from './permissions'
import { registerProjectHandlers } from './projects'
import { registerProviderRuntimeHandlers } from './providerRuntime'
import { registerAgentRunHandlers } from './agentRuns'
import { registerSessionStatusHandlers } from './sessionStatus'
import { registerSupportHandlers } from './support'
import { registerSiteIconHandlers } from './siteIcons'
import { registerBrowserNetworkHandlers } from './browserNetwork'
import { registerBrowserLibraryHandlers } from './browserLibrary'
import { registerCommandLineHandlers } from './commandLine'
import { registerScheduleHandlers } from './schedules'
import { registerSessionHandlers } from './sessions'
import { registerPullRequestHandlers } from './pullRequests'
import { registerWorktreeHandlers } from './worktrees'
import { registerAppMenuHandlers } from './appMenus'
import { registerCredentialHandlers } from './credentials'
import { registerCompanionHandlers } from './companion'
import { registerPanelWindowHandlers } from './panelWindows'

/**
 * Registers all IPC handlers. Call after store and db are initialized.
 */
export function registerAllHandlers(): void {
  registerWindowHandlers()
  registerPanelWindowHandlers()
  registerAppMenuHandlers()
  registerSiteIconHandlers()
  registerProviderRuntimeHandlers()
  registerSettingsHandlers()
  registerDatabaseHandlers()
  registerConversationModelHandlers()
  registerProjectHandlers()
  registerWorktreeHandlers()
  registerWorkspaceHandlers()
  registerCheckpointHandlers()
  registerMcpHandlers()
  registerPermissionHandlers()
  registerBrowserNetworkHandlers()
  registerBrowserLibraryHandlers()
  registerCredentialHandlers()
  registerPullRequestHandlers()
  registerSupportHandlers()
  registerAgentRunHandlers()
  registerSessionStatusHandlers()
  registerCommandLineHandlers()
  registerScheduleHandlers()
  registerSessionHandlers()
  registerCompanionHandlers()
}
