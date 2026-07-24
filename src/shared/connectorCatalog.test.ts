import { describe, expect, it } from 'vitest'
import type { McpHttpServerConfig } from './types'
import { createCatalogMcpConfig, MCP_CONNECTOR_CATALOG } from './connectorCatalog'
import { validateMcpServerConfig } from './mcp'

describe('MCP connector catalog', () => {
  it('contains unique HTTPS vendor endpoints', () => {
    expect(new Set(MCP_CONNECTOR_CATALOG.map(({ id }) => id)).size).toBe(
      MCP_CONNECTOR_CATALOG.length
    )
    for (const connector of MCP_CONNECTOR_CATALOG) {
      expect(new URL(connector.endpoint).protocol).toBe('https:')
      expect(new URL(connector.source).protocol).toBe('https:')
    }
  })

  it('creates a collision-free, confirmation-gated OAuth connector', () => {
    const first = createCatalogMcpConfig('notion', [])
    const second = createCatalogMcpConfig('notion', [first])

    expect(first).toMatchObject({
      id: 'notion',
      authentication: 'oauth',
      approvalMode: 'prompt',
      enabled: true
    })
    expect(second.id).toBe('notion-2')
    expect(validateMcpServerConfig(second)).toBeNull()
  })

  it('rejects a catalog connector whose endpoint has been replaced', () => {
    expect(
      validateMcpServerConfig({
        ...createCatalogMcpConfig('airtable', []),
        url: 'https://lookalike.example.com/mcp'
      })
    ).toContain('verified official')
  })

  it('rejects an unknown catalog identity from untrusted settings data', () => {
    const config = {
      ...createCatalogMcpConfig('notion', []),
      catalogId: 'lookalike'
    }
    expect(
      validateMcpServerConfig(config as unknown as McpHttpServerConfig)
    ).toContain('identity is invalid')
  })
})
