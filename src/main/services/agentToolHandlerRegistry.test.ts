import { describe, expect, it } from 'vitest'
import { toolExecutionSucceeded } from '../../shared/agentRuntime'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

const context = {
  runId: 'run-1',
  signal: new AbortController().signal
}

describe('AgentToolHandlerRegistry', () => {
  it('registers and disposes scoped handlers', async () => {
    const registry = new AgentToolHandlerRegistry()
    const dispose = registry.register('example', async ({ title }) =>
      toolExecutionSucceeded({ title, data: { ok: true } })
    )
    await expect(
      registry.execute({ name: 'example', title: 'Example', arguments: {}, context })
    ).resolves.toMatchObject({ status: 'success', data: { ok: true } })
    dispose()
    await expect(
      registry.execute({ name: 'example', title: 'Example', arguments: {}, context })
    ).resolves.toMatchObject({ status: 'error', error: { code: 'unknown_tool' } })
  })

  it('rejects ambiguous duplicate ownership', () => {
    const registry = new AgentToolHandlerRegistry()
    const handler = async () => toolExecutionSucceeded({ title: 'Example' })
    registry.register('example', handler)
    expect(() => registry.register('example', handler)).toThrow('Duplicate agent tool handler')
  })
})
