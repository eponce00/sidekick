import { describe, expect, it } from 'vitest'
import { normalizeAgentToolParameters, workspaceToolDefinitions } from './agentToolDefinitions'

describe('workspace tool definitions', () => {
  it.each([
    ['apply-patch', ['read', 'apply_patch']],
    ['claude-edit', ['read', 'Edit', 'Write', 'delete_file']],
    ['search-replace', ['read', 'search_replace', 'write', 'delete_file']],
    ['structured-edit', ['read', 'edit', 'write', 'delete_file']]
  ] as const)('exposes the calibrated %s editing contract', (dialect, expected) => {
    expect(workspaceToolDefinitions(dialect).map(({ function: tool }) => tool.name)).toEqual(
      expected
    )
  })

  it('requires project-relative paths for the canonical read contract', () => {
    const read = workspaceToolDefinitions('apply-patch').find(
      ({ function: tool }) => tool.name === 'read'
    )
    expect(read?.function.parameters.required).toEqual(['path'])
    expect(read?.function.parameters.properties).toHaveProperty('start_line')
    expect(read?.function.parameters.properties).toHaveProperty('cursor')
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
