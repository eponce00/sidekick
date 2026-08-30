import { describe, expect, it } from 'vitest'
import { UiContributionRegistry, resolveToolView } from './uiContributions'

describe('UiContributionRegistry', () => {
  it('orders typed contributions and reverses their lifecycle', () => {
    const registry = new UiContributionRegistry<string>()
    registry.register({ id: 'low', priority: 1, value: 'low' })
    const dispose = registry.register({ id: 'high', priority: 10, value: 'high' })
    expect(registry.list().map(({ value }) => value)).toEqual(['high', 'low'])
    dispose()
    expect(registry.list().map(({ value }) => value)).toEqual(['low'])
  })

  it('selects tool views from durable presentation semantics', () => {
    expect(
      resolveToolView({
        id: 'tool-1',
        title: 'Delegate',
        command: '',
        status: 'running',
        presentation: { kind: 'subagent', title: 'Delegate task' }
      })
    ).toBe('subagent')
    expect(
      resolveToolView({
        id: 'tool-2',
        title: 'Update file',
        command: '',
        status: 'success',
        presentation: { kind: 'diff', title: 'Update file' }
      })
    ).toBe('diff')
    expect(
      resolveToolView({ id: 'tool-3', title: 'Unknown', command: '', status: 'success' })
    ).toBe('generic')
  })
})
