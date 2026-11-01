import { describe, expect, it } from 'vitest'
import { getSubAgentToolDefinitions, getToolDefinitions } from './toolDefinitions'

describe('tool definitions', () => {
  it('offers the native wait tool to direct and delegated agents', () => {
    const direct = getToolDefinitions(false).find(({ function: tool }) => tool.name === 'wait')
    const delegated = getSubAgentToolDefinitions(false).find(
      ({ function: tool }) => tool.name === 'wait'
    )

    // Waiting is for something to happen; the seconds are only a limit.
    expect(direct?.function.name).toBe('wait')
    expect(direct?.function.parameters.required ?? []).toEqual([])
    expect(delegated).toEqual(direct)
  })
})
