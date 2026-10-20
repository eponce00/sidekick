import { toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { McpToolInfo } from '../../shared/types'
import type { McpClientManager } from './mcpClientManager'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ToolOutputStore } from './toolOutputStore'

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

/**
 * An MCP tool result as the model reads it. Its text items are text already; as JSON every line
 * break became an escape and an image became a page of base64. Anything not in the result shape
 * the protocol defines stays JSON.
 */
export function mcpResultText(value: unknown): string {
  const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!result || !Array.isArray(result.content)) return JSON.stringify(value) ?? ''
  const parts = (result.content as unknown[]).map((item) => {
    const part = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    if (part.type === 'text' && typeof part.text === 'string') return part.text
    if (part.type === 'image' || part.type === 'audio')
      return `[${part.type}: ${String(part.mimeType || 'unknown type')}, not shown as text]`
    if (part.type === 'resource_link')
      return `[link: ${String(part.name || '')} ${String(part.uri || '')}]`
    if (part.type === 'resource' && part.resource && typeof part.resource === 'object') {
      const resource = part.resource as Record<string, unknown>
      return typeof resource.text === 'string'
        ? `[resource ${String(resource.uri || '')}]\n${resource.text}`
        : `[resource ${String(resource.uri || '')}: ${String(resource.mimeType || 'binary')}, not shown as text]`
    }
    return JSON.stringify(item)
  })
  if (!parts.length && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent))
  return [result.isError === true ? 'The tool reported an error.' : '', ...parts]
    .filter(Boolean)
    .join('\n')
}

export function registerMcpToolHandlers(
  registry: AgentToolHandlerRegistry,
  options: {
    mcp: McpClientManager
    available: Map<string, McpToolInfo>
    enabled: Map<string, McpToolInfo>
    readReceipts: Map<string, string>
    outputs: ToolOutputStore
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
      const shown = await options.outputs.apply(mcpResultText(data), { preview: 'head-tail' })
      return toolExecutionSucceeded({
        title,
        data,
        modelContent: shown.content,
        output: shown.output
      })
    })
  }
}
