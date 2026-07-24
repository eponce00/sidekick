import { describe, expect, it } from 'vitest'
import { normalizeAgentToolParameters, workspaceToolDefinitions } from './agentToolDefinitions'

describe('workspace tool definitions', () => {
  it.each([
    [
      'apply-patch',
      ['list_workspace_files', 'read_workspace_file', 'search_workspace_files', 'apply_patch']
    ],
    [
      'claude-edit',
      [
        'list_workspace_files',
        'read_workspace_file',
        'search_workspace_files',
        'Edit',
        'Write',
        'delete_file'
      ]
    ],
    [
      'search-replace',
      [
        'list_workspace_files',
        'read_workspace_file',
        'search_workspace_files',
        'search_replace',
        'write',
        'delete_file'
      ]
    ],
    [
      'structured-edit',
      [
        'list_workspace_files',
        'read_workspace_file',
        'search_workspace_files',
        'edit',
        'write',
        'delete_file'
      ]
    ]
  ] as const)('exposes only the %s editing dialect', (dialect, names) => {
    expect(workspaceToolDefinitions(dialect).map(({ function: tool }) => tool.name)).toEqual(names)
  })

  it('normalizes MCP references into a portable recursive schema', () => {
    const schema = normalizeAgentToolParameters({
      type: 'object',
      required: ['request'],
      properties: { request: { $ref: '#/$defs/Request' } },
      $defs: {
        Request: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } }
        }
      }
    })

    expect(schema).toEqual({
      type: 'object',
      required: ['request'],
      properties: {
        request: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } }
        }
      }
    })
  })
})
