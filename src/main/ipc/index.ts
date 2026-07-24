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
import { registerSupportHandlers } from './support'

/**
 * Registers all IPC handlers. Call after store and db are initialized.
 */
export function registerAllHandlers(): void {
  registerWindowHandlers()
  registerProviderRuntimeHandlers()
  registerSettingsHandlers()
  registerDatabaseHandlers()
  registerProjectHandlers()
  registerWorkspaceHandlers()
  registerCheckpointHandlers()
  registerMcpHandlers()
  registerPermissionHandlers()
  registerSupportHandlers()
  registerCollaborationHandlers()
  registerAgentRunHandlers()
}
