import { toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { McpToolInfo } from '../../shared/types'
import type { McpClientManager } from './mcpClientManager'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

export function registerMcpToolHandlers(
  registry: AgentToolHandlerRegistry,
  options: {
    mcp: McpClientManager
    available: Map<string, McpToolInfo>
    enabled: Map<string, McpToolInfo>
    readReceipts: Map<string, string>
  }
): void {
  registry.register('search_tools', async ({ title, arguments: args }) => {
    const terms = String(args.query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    const limit = bounded(args.max_results, 6, 1, 12)
    const matches = [...options.available.entries()]
      .map(([functionName, tool]) => ({
        functionName,
        tool,
        haystack:
          `${functionName} ${tool.serverName} ${tool.name} ${tool.description || ''}`.toLowerCase()
      }))
      .filter(({ haystack }) => terms.every((term) => haystack.includes(term)))
      .slice(0, limit)
    for (const { functionName, tool } of matches) options.enabled.set(functionName, tool)
    const data = matches.map(({ functionName, tool }) => ({
      name: functionName,
      server: tool.serverName,
      description: tool.description || tool.name
    }))
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: matches.length
        ? `Enabled ${matches.length} matching tool(s): ${matches.map(({ functionName }) => functionName).join(', ')}`
        : 'No matching MCP tools found.'
    })
  })

  for (const [name, tool] of options.available) {
    registry.register(name, async ({ title, arguments: args, context }) => {
      options.readReceipts.clear()
      const data = await options.mcp.callTool(tool.serverId, tool.name, args, {
        signal: context.signal
      })
      return toolExecutionSucceeded({ title, data })
    })
  }
}
