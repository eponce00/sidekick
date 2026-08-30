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

  it('uses the same canonical workspace tools for every provider', () => {
    const names = () =>
      getToolDefinitions(false, '/workspace').map(({ function: tool }) => tool.name)

    const openAi = names()
    expect(openAi).toContain('apply_patch')
    expect(openAi).toEqual(expect.arrayContaining(['read', 'shell', 'apply_patch', 'tool_output']))

    const claude = names()
    expect(claude).toEqual(expect.arrayContaining(['read', 'shell', 'apply_patch', 'tool_output']))
    expect(claude).toEqual(openAi)
  })
})
