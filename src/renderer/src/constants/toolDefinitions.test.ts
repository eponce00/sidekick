import { describe, expect, it } from 'vitest'
import { getSubAgentToolDefinitions, getToolDefinitions } from './toolDefinitions'

describe('tool definitions', () => {
  it('offers the bounded native wait tool to direct and delegated agents', () => {
    const direct = getToolDefinitions(false).find(({ function: tool }) => tool.name === 'wait')
    const delegated = getSubAgentToolDefinitions(false).find(
      ({ function: tool }) => tool.name === 'wait'
    )

    expect(direct?.function.parameters.required).toEqual(['seconds'])
    expect(direct?.function.description).toContain('capped at 200 seconds')
    expect(delegated).toEqual(direct)
  })

  it('routes direct-chat editing tools by the selected model without mixing dialects', () => {
    const names = (model: string, providerKind: 'openrouter' | 'anthropic') =>
      getToolDefinitions(false, '/workspace', [], { model, providerKind }).map(
        ({ function: tool }) => tool.name
      )

    const openAi = names('openai/gpt-5.4-codex', 'openrouter')
    expect(openAi).toContain('apply_patch')
    expect(openAi).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'edit', 'write']))

    const claude = names('claude-sonnet-5', 'anthropic')
    expect(claude).toEqual(expect.arrayContaining(['Edit', 'Write', 'delete_file']))
    expect(claude).not.toContain('apply_patch')
  })
})
