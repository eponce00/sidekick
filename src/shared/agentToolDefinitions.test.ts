import { describe, expect, it } from 'vitest'
import { normalizeAgentToolParameters, workspaceToolDefinitions } from './agentToolDefinitions'

describe('workspace tool definitions', () => {
  it.each(['apply-patch', 'claude-edit', 'search-replace', 'structured-edit'] as const)(
    'exposes one canonical contract regardless of legacy %s metadata',
    (dialect) => {
      expect(workspaceToolDefinitions(dialect).map(({ function: tool }) => tool.name)).toEqual([
        'read',
        'apply_patch'
      ])
    }
  )

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
