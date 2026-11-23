import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import { mcpDirectoryText, type McpDirectoryEntry } from '../../shared/agentToolCatalog'
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
  return parts.filter(Boolean).join('\n')
}

/** Words too common to tell one tool from another. */
const STOP_WORDS = new Set(
  'a an and are as at be by can do for from get how i in is it me my of on or the this to use using want with tool tools mcp server connector'.split(
    ' '
  )
)

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map(stem)
  )
}

/**
 * The tools a search finds, best first. A tool or connector named exactly comes first; otherwise
 * a word in a tool's or connector's name counts more than one in its description. A tool needs
 * only one matching word: models search in sentences, and requiring every word found nothing.
 */
export function rankMcpTools(
  query: string,
  available: ReadonlyMap<string, McpToolInfo>,
  limit: number
): string[] {
  const exact = query.trim().toLowerCase()
  const terms = words(query)
  return [...available]
    .map(([functionName, tool], order) => {
      const names = [functionName, tool.name, `${tool.serverName}/${tool.name}`]
      let score = names.some((name) => name.toLowerCase() === exact) ? 100 : 0
      const named = words(`${tool.serverId} ${tool.serverName} ${tool.name}`)
      const described = words(tool.description || '')
      for (const term of terms) score += named.has(term) ? 3 : described.has(term) ? 1 : 0
      return { functionName, score, order }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map(({ functionName }) => functionName)
}

export function registerMcpToolHandlers(
  registry: AgentToolHandlerRegistry,
  options: {
    mcp: McpClientManager
    available: Map<string, McpToolInfo>
    /** What the model is told exists, for a search that finds nothing. */
    directory: readonly McpDirectoryEntry[]
    enabled: Map<string, McpToolInfo>
    readReceipts: Map<string, string>
    outputs: ToolOutputStore
  }
): void {
  registry.register('search_tools', async ({ title, arguments: args }) => {
    const limit = bounded(args.max_results, 6, 1, 12)
    const matches = rankMcpTools(String(args.query || ''), options.available, limit).map(
      (functionName) => ({ functionName, tool: options.available.get(functionName)! })
    )
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
        ? `Enabled ${matches.length} tool(s), callable from your next turn:\n${matches
            .map(({ functionName, tool }) => `- ${functionName} (${tool.serverName}: ${tool.name})`)
            .join('\n')}`
        : `No MCP tool matched. Search again with one of these names.\n${mcpDirectoryText(options.directory)}`
    })
  })

  for (const [name, tool] of options.available) {
    registry.register(name, async ({ title, arguments: args, context }) => {
      options.readReceipts.clear()
      const data = await options.mcp.callTool(tool.serverId, tool.name, args, {
        signal: context.signal
      })
      const text = mcpResultText(data)
      const shown = await options.outputs.apply(text, { preview: 'head-tail' })
      // A tool's own failure arrives as a result flagged isError, not as a protocol error.
      if ((data as { isError?: unknown } | null)?.isError === true) {
        return toolExecutionFailed({
          title,
          code: 'command_failed',
          message: text.slice(0, 500) || `${tool.name} reported an error without a message.`,
          data,
          modelContent: `The tool reported an error.\n${shown.content}`,
          output: shown.output
        })
      }
      return toolExecutionSucceeded({
        title,
        data,
        modelContent: shown.content,
        output: shown.output
      })
    })
  }
}
