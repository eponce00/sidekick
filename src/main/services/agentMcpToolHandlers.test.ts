import { describe, expect, it } from 'vitest'
import type { McpToolInfo } from '../../shared/types'
import { rankMcpTools } from './agentMcpToolHandlers'

function tool(serverName: string, name: string, description: string): [string, McpToolInfo] {
  const serverId = serverName.toLowerCase()
  return [
    `mcp__${serverId}__${name}`,
    { serverId, serverName, name, description, inputSchema: {}, approvalMode: 'prompt' }
  ]
}

const available = new Map([
  tool('Files', 'read_text_file', 'Read the complete contents of a file as text'),
  tool('Files', 'list_directory', 'Get a detailed listing of all files and directories'),
  tool('DeepWiki', 'ask_wiki_question', 'Ask any question about a GitHub repository'),
  tool(
    'DeepWiki',
    'read_wiki_structure',
    'Get a list of documentation topics for a GitHub repository'
  )
])

describe('MCP tool search', () => {
  // Models search in sentences; requiring every word found nothing in real runs.
  it('finds tools from a sentence that only partly matches', () => {
    expect(rankMcpTools('ask a question about the docs of a GitHub repo', available, 6)[0]).toBe(
      'mcp__deepwiki__ask_wiki_question'
    )
    expect(rankMcpTools('list the files in my folder', available, 6)[0]).toBe(
      'mcp__files__list_directory'
    )
  })

  it("selects a connector's tools by its name, and a tool by its exact name", () => {
    expect(rankMcpTools('DeepWiki', available, 6)).toEqual([
      'mcp__deepwiki__ask_wiki_question',
      'mcp__deepwiki__read_wiki_structure'
    ])
    expect(rankMcpTools('read_wiki_structure', available, 1)).toEqual([
      'mcp__deepwiki__read_wiki_structure'
    ])
  })

  it('finds nothing for words no tool has', () => {
    expect(rankMcpTools('send an email', available, 6)).toEqual([])
  })
})
