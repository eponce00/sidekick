import { BrowserWindow, dialog, ipcMain } from 'electron'
import { validateMcpServerConfig } from '../../shared/mcp'
import type { McpServerConfig, McpServerStatus } from '../../shared/types'
import { McpClientManager } from '../services/mcpClientManager'
import { approveMcpServers, mainProcessMcpTrust } from '../services/mcpServerTrust'
import { describeMcpServer } from './settings'
import { getStore } from './state'

const manager = new McpClientManager(undefined, undefined, undefined, mainProcessMcpTrust)

function configs(): McpServerConfig[] {
  const settings = getStore().get('settings', {}) as { mcpServers?: McpServerConfig[] }
  if (!Array.isArray(settings.mcpServers)) return []
  return settings.mcpServers.filter(
    (config) =>
      config &&
      typeof config.id === 'string' &&
      /^[a-zA-Z0-9_-]+$/.test(config.id) &&
      typeof config.name === 'string' &&
      validateMcpServerConfig(config) === null
  )
}

/** Shows everything that decides what a connector runs and asks the user to allow it. */
export async function confirmMcpServer(
  config: McpServerConfig,
  parent: BrowserWindow | null,
  requester?: string
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    title: 'Approve MCP connector',
    message: `Allow ${config.name} to run?`,
    detail: [
      requester ? `Requested by ${requester}, not from the Settings window.` : null,
      describeMcpServer(config),
      'Local connectors run with your account permissions. SideKick asks again whenever this connector changes.'
    ]
      .filter(Boolean)
      .join('\n\n'),
    buttons: ['Cancel', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const window = parent && !parent.isDestroyed() ? parent : null
  const answer = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return answer.response === 1
}

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:listTools', async () => {
    try {
      await manager.sync(configs())
      const result = await manager.listTools()
      return { ok: true, ...result }
    } catch (error) {
      return {
        ok: false,
        tools: [],
        statuses: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('mcp:authenticate', async (_event, serverId: unknown) => {
    if (typeof serverId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
      return { ok: false, tools: [], statuses: [], error: 'Invalid MCP connector ID.' }
    }
    try {
      await manager.sync(configs())
      await manager.authenticate(serverId)
      return { ok: true, ...(await manager.listTools()) }
    } catch (error) {
      const current = await manager.listTools().catch(() => ({ tools: [], statuses: [] }))
      return {
        ok: false,
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('mcp:approve', async (event, serverId: unknown) => {
    if (typeof serverId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
      return { ok: false, tools: [], statuses: [], error: 'Invalid MCP connector ID.' }
    }
    const config = configs().find((candidate) => candidate.id === serverId)
    if (!config) return { ok: false, tools: [], statuses: [], error: 'Unknown MCP connector.' }
    // The renderer only names the server; the dialog shows what is stored, which is what runs.
    const allowed = await confirmMcpServer(config, BrowserWindow.fromWebContents(event.sender))
    if (allowed) approveMcpServers([config])
    try {
      await manager.sync(configs())
      return { ok: allowed, ...(await manager.listTools()) }
    } catch (error) {
      return {
        ok: false,
        tools: [],
        statuses: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('mcp:disconnect', async (_event, serverId: unknown) => {
    if (typeof serverId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
      return { ok: false, tools: [], statuses: [], error: 'Invalid MCP connector ID.' }
    }
    try {
      await manager.sync(configs())
      await manager.disconnect(serverId)
      return { ok: true, ...(await manager.listTools()) }
    } catch (error) {
      const current = await manager.listTools().catch(() => ({ tools: [], statuses: [] }))
      return {
        ok: false,
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}

/** Connection state of the configured connectors, for diagnostics outside the renderer. */
export async function mcpServerStatuses(): Promise<McpServerStatus[]> {
  await manager.sync(configs())
  return (await manager.listTools()).statuses
}

export async function closeMcpConnections(): Promise<void> {
  await manager.close()
}
