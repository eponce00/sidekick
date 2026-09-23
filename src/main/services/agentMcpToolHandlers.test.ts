import { expect, it } from 'vitest'
import type { McpToolInfo } from '../../shared/types'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerMcpToolHandlers } from './agentMcpToolHandlers'
import type { McpClientManager } from './mcpClientManager'

it('points a search for a skill tool at the skill instead of reporting nothing', async () => {
  const registry = new AgentToolHandlerRegistry()
  registerMcpToolHandlers(registry, {
    mcp: {} as McpClientManager,
    available: new Map<string, McpToolInfo>(),
    enabled: new Map(),
    readReceipts: new Map()
  })
  const search = async (query: string) =>
    (
      await registry.execute({
        name: 'search_tools',
        title: 'Search tools',
        arguments: { query },
        context: { runId: 'search-test', signal: new AbortController().signal }
      })
    ).modelContent

  expect(await search('create_artifact')).toContain(
    'create_artifact comes from the web-artifacts skill'
  )
  expect(await search('render artifact')).toContain('use_skill')
  expect(await search('spreadsheet')).toBe('No matching MCP tools found.')
})
