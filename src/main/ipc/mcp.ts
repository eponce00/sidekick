import { ipcMain } from 'electron'
import { validateMcpServerConfig } from '../../shared/mcp'
import type { McpServerConfig } from '../../shared/types'
import { McpClientManager } from '../services/mcpClientManager'
import { getStore } from './state'

const manager = new McpClientManager()

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

export async function closeMcpConnections(): Promise<void> {
  await manager.close()
}
