import type {
  McpConnectorCatalogId,
  McpHttpServerConfig,
  McpServerConfig
} from './types'

export interface McpConnectorCatalogEntry {
  id: McpConnectorCatalogId
  name: string
  endpoint: string
  source: string
}

/** Only vendor-published Streamable HTTP endpoints with OAuth/DCR belong here. */
export const MCP_CONNECTOR_CATALOG: readonly McpConnectorCatalogEntry[] = [
  {
    id: 'atlassian',
    name: 'Atlassian',
    endpoint: 'https://mcp.atlassian.com/v1/mcp/authv2',
    source: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/'
  },
  {
    id: 'notion',
    name: 'Notion',
    endpoint: 'https://mcp.notion.com/mcp',
    source: 'https://developers.notion.com/guides/mcp/get-started-with-mcp'
  },
  {
    id: 'airtable',
    name: 'Airtable',
    endpoint: 'https://mcp.airtable.com/mcp',
    source: 'https://support.airtable.com/v1/docs/using-the-airtable-mcp-server'
  }
] as const

export function mcpConnectorCatalogEntry(
  id: McpConnectorCatalogId
): McpConnectorCatalogEntry {
  const entry = findMcpConnectorCatalogEntry(id)
  if (!entry) throw new Error(`Unknown connector catalog entry: ${id}`)
  return entry
}

export function findMcpConnectorCatalogEntry(id: string): McpConnectorCatalogEntry | undefined {
  return MCP_CONNECTOR_CATALOG.find((candidate) => candidate.id === id)
}

export function createCatalogMcpConfig(
  id: McpConnectorCatalogId,
  existing: readonly McpServerConfig[]
): McpHttpServerConfig {
  const entry = mcpConnectorCatalogEntry(id)
  const existingIds = new Set(existing.map((server) => server.id))
  let serverId: string = id
  let suffix = 2
  while (existingIds.has(serverId)) serverId = `${id}-${suffix++}`
  return {
    id: serverId,
    name: entry.name,
    transport: 'streamable-http',
    url: entry.endpoint,
    authentication: 'oauth',
    approvalMode: 'prompt',
    enabled: true,
    catalogId: entry.id
  }
}
