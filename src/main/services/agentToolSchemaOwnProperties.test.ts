import { expect, it } from 'vitest'
import { normalizeAgentToolParameters } from '../../shared/agentToolDefinitions'
import { validateAgentToolArguments } from './agentToolRegistry'

it('runtime requires own argument members for a normalized constructor property', () => {
  const parameters = normalizeAgentToolParameters(
    JSON.parse(
      '{"type":"object","properties":{"constructor":{"type":"string"}},"required":["constructor"]}'
    )
  )
  const tool = {
    type: 'function' as const,
    function: { name: 'fixture', description: '', parameters }
  }
  expect(validateAgentToolArguments(tool, {})).toContainEqual(
    expect.objectContaining({ code: 'required', path: 'constructor' })
  )
  expect(validateAgentToolArguments(tool, { constructor: 'value' })).toEqual([])
})
