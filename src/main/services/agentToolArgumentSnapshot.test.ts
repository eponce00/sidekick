import { expect, it, vi } from 'vitest'
import {
  AgentToolRegistry,
  prepareAgentToolCall,
  validatePreparedAgentToolCall
} from './agentToolRegistry'

// Regression: caller-owned nested objects must not outlive validation by reference.
it('executes the nested arguments that were validated before entering the exclusive queue', async () => {
  const registry = new AgentToolRegistry()
  const catalog = {
    surface: 'conversation' as const,
    browserEnabled: true,
    workspaceRoot: '/synthetic-project'
  }
  const context = { runId: 'snapshot-audit', signal: new AbortController().signal }
  let release!: () => void
  const blocking = registry.execute(
    {
      catalog,
      context,
      call: { id: 'blocker', name: 'wait', arguments: { seconds: 1 } },
      title: 'Blocker'
    },
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    }
  )
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const fields: Array<Record<string, unknown>> = [{ kind: 'checkbox', ref: 'b1', checked: true }]
  const call = { id: 'queued', name: 'browser_fill_form', arguments: { fields } }
  const prepared = prepareAgentToolCall(catalog, call)
  expect(validatePreparedAgentToolCall(catalog, prepared.call, 'Fill')).toBeNull()
  let executed: unknown
  const pending = registry.execute({ catalog, context, call, title: 'Fill' }, async (args) => {
    executed = args
    return {}
  })
  // Mutation from an internal caller retaining the original object, not a model request.
  fields[0].checked = 'not-a-boolean'
  expect(
    validatePreparedAgentToolCall(catalog, prepareAgentToolCall(catalog, call).call, 'Fill')?.error
      ?.code
  ).toBe('invalid_arguments')
  release()
  const [, result] = await Promise.all([blocking, pending])
  expect(result.status).toBe('success')
  expect(executed).toEqual({ fields: [{ kind: 'checkbox', ref: 'b1', checked: true }] })
})

it('retains the schema-valid argument values prepared before an approval wait', async () => {
  const catalog = {
    surface: 'conversation' as const,
    browserEnabled: true,
    workspaceRoot: '/synthetic-project'
  }
  const fields = [{ kind: 'textbox', ref: 'b1', value: 'approved synthetic value' }]
  const prepared = prepareAgentToolCall(catalog, {
    id: 'approved-call',
    name: 'browser_fill_form',
    arguments: { fields }
  })
  expect(validatePreparedAgentToolCall(catalog, prepared.call, 'Fill')).toBeNull()
  // Represents an asynchronous approval boundary; this does not exercise approval UI.
  await Promise.resolve()
  fields[0].value = 'substituted synthetic value'
  let executed: unknown
  await new AgentToolRegistry().execute(
    {
      catalog,
      call: prepared.call,
      title: 'Fill',
      context: { runId: 'approval-snapshot', signal: new AbortController().signal }
    },
    async (args) => {
      executed = args
      return {}
    }
  )
  expect(executed).toEqual({
    fields: [{ kind: 'textbox', ref: 'b1', value: 'approved synthetic value' }]
  })
})

it.each([
  () => ({ extra: () => 'secret-native-error' }),
  () => ({ extra: new Date() }),
  () => ({ extra: new Map() }),
  () => ({ extra: BigInt(1) }),
  () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    return cycle
  },
  () => ({ extra: Object.create({ inherited: 'secret-native-error' }) })
])(
  'rejects unsupported runtime values as fixed invalid input without dispatch',
  async (makeArgs) => {
    const executor = vi.fn()
    const result = await new AgentToolRegistry().execute(
      {
        catalog: { surface: 'conversation' },
        call: { id: 'invalid', name: 'wait', arguments: { seconds: 1, ...makeArgs() } },
        title: 'Wait',
        context: { runId: 'safe-error', signal: new AbortController().signal }
      },
      executor
    )
    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'invalid_arguments',
        message: 'Tool arguments must be safely copyable JSON data.'
      }
    })
    expect(JSON.stringify(result)).not.toContain('secret-native-error')
    expect(executor).not.toHaveBeenCalled()
  }
)

it('does not invoke argument getters while snapshotting', () => {
  const getter = vi.fn(() => {
    throw new Error('secret-getter-error')
  })
  const args = { seconds: 1 }
  Object.defineProperty(args, 'extra', { enumerable: true, get: getter })
  const prepared = prepareAgentToolCall(
    { surface: 'conversation' },
    { id: 'getter', name: 'wait', arguments: args }
  )
  expect(prepared.argumentSnapshotFailed).toBe(true)
  expect(prepared.call.arguments).toEqual({})
  expect(getter).not.toHaveBeenCalled()
})

it('copies shared acyclic JSON references without retaining caller ownership', () => {
  const shared = { value: 'before' }
  const prepared = prepareAgentToolCall(
    { surface: 'conversation' },
    { id: 'shared', name: 'wait', arguments: { seconds: 1, left: shared, right: shared } }
  )
  shared.value = 'after'
  expect(prepared.call.arguments).toMatchObject({
    left: { value: 'before' },
    right: { value: 'before' }
  })
  expect(prepared.argumentSnapshotFailed).toBeUndefined()
})

it('preserves optional undefined object properties for main-generated shell calls', async () => {
  const executor = vi.fn(async (args) => args)
  const result = await new AgentToolRegistry().execute(
    {
      catalog: { surface: 'conversation', workspaceRoot: '/synthetic-project' },
      call: {
        id: 'hook',
        name: 'shell',
        arguments: { command: 'synthetic-command-not-executed', cwd: undefined }
      },
      title: 'Hook',
      context: { runId: 'hook-run', signal: new AbortController().signal }
    },
    executor
  )
  expect(result.status).toBe('success')
  expect(executor.mock.calls[0][0]).toHaveProperty('cwd', undefined)
})

it('preserves nested optional undefined but leaves required undefined invalid', () => {
  const catalog = {
    surface: 'conversation' as const,
    browserEnabled: true,
    workspaceRoot: '/synthetic-project'
  }
  const fields = [
    { kind: 'checkbox' as string | undefined, ref: 'b1', checked: true, selector: undefined }
  ]
  const call = { id: 'optional', name: 'browser_fill_form', arguments: { fields } }
  const prepared = prepareAgentToolCall(catalog, call)
  expect(prepared.argumentSnapshotFailed).toBeUndefined()
  expect(validatePreparedAgentToolCall(catalog, prepared.call, 'Fill')).toBeNull()
  expect((prepared.call.arguments.fields as typeof fields)[0]).toHaveProperty('selector', undefined)
  fields[0].kind = undefined
  const required = prepareAgentToolCall(catalog, call)
  expect(required.argumentSnapshotFailed).toBeUndefined()
  expect(validatePreparedAgentToolCall(catalog, required.call, 'Fill')?.error?.code).toBe(
    'invalid_arguments'
  )
})
