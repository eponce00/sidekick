import type { McpServerConfig, McpToolInfo, ToolRisk } from './types'
import { findMcpConnectorCatalogEntry } from './connectorCatalog'

export function isSecureMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function validateMcpServerConfig(config: McpServerConfig): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(config.id)) return 'Server ID is invalid.'
  if (!config.name.trim()) return 'Display name is required.'
  if (config.transport !== 'stdio' && config.transport !== 'streamable-http') {
    return 'Connection transport is required.'
  }
  if (config.transport === 'stdio') {
    if (!config.command.trim()) return 'Command is required for a local server.'
    if (config.args && !config.args.every((arg) => typeof arg === 'string')) {
      return 'Every command argument must be text.'
    }
    return null
  }
  if (!config.url.trim()) return 'URL is required for a remote server.'
  if (!isSecureMcpUrl(config.url)) {
    return 'Remote MCP URLs must use HTTPS (HTTP is allowed only for loopback addresses).'
  }
  if (config.authentication !== 'none' && config.authentication !== 'oauth') {
    return 'Remote connector authentication mode is required.'
  }
  if (config.catalogId) {
    const official = findMcpConnectorCatalogEntry(config.catalogId)
    if (!official) return 'Connector catalog identity is invalid.'
    if (config.url !== official.endpoint || config.authentication !== 'oauth') {
      return `${official.name} must use its verified official OAuth endpoint.`
    }
  }
  return null
}

/**
 * MCP annotations are untrusted hints. They only lower risk after the user explicitly opts in,
 * and only for the narrowest possible combination of hints.
 */
export function mcpToolRisk(tool: McpToolInfo): ToolRisk {
  if (
    tool.approvalMode === 'reads-auto' &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint !== true &&
    tool.annotations.openWorldHint !== true
  ) {
    return 'read'
  }
  return 'network'
}
