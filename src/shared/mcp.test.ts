import { describe, expect, it } from 'vitest'
import { isSecureMcpUrl, mcpToolRisk, validateMcpServerConfig } from './mcp'

describe('MCP connector policy', () => {
  it('requires encrypted transport off the loopback interface', () => {
    expect(isSecureMcpUrl('https://connect.example.com/mcp')).toBe(true)
    expect(isSecureMcpUrl('http://localhost:3000/mcp')).toBe(true)
    expect(isSecureMcpUrl('http://127.0.0.1:3000/mcp')).toBe(true)
    expect(isSecureMcpUrl('http://connect.example.com/mcp')).toBe(false)
    expect(
      validateMcpServerConfig({
        id: 'slack',
        name: 'Slack',
        transport: 'streamable-http',
        url: 'http://connect.example.com/mcp',
        authentication: 'oauth',
        approvalMode: 'prompt',
        enabled: true
      })
    ).toContain('HTTPS')
  })

  it('only lowers risk for explicitly opted-in, narrowly annotated reads', () => {
    const base = {
      serverId: 'jira',
      serverName: 'Jira',
      name: 'search',
      inputSchema: {}
    }
    expect(
      mcpToolRisk({ ...base, annotations: { readOnlyHint: true }, approvalMode: 'prompt' })
    ).toBe('network')
    expect(
      mcpToolRisk({ ...base, annotations: { readOnlyHint: true }, approvalMode: 'reads-auto' })
    ).toBe('read')
    expect(
      mcpToolRisk({
        ...base,
        annotations: { readOnlyHint: true, openWorldHint: true },
        approvalMode: 'reads-auto'
      })
    ).toBe('network')
  })
})
