import { describe, expect, it, vi } from 'vitest'
import type { AgentToolCatalogOptions } from '../../shared/agentToolCatalog'
import {
  AgentToolExecutionError,
  AgentToolRegistry,
  type AgentToolExecutor
} from './agentToolRegistry'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { toolExecutionSucceeded } from '../../shared/agentRuntime'

const registry = new AgentToolRegistry()

function input(
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal,
  catalog: AgentToolCatalogOptions = { surface: 'conversation', webSearchEnabled: true }
) {
  return {
    catalog,
    call: { id: 'call-1', name, arguments: args },
    title: 'Test tool',
    context: { runId: 'run-1', signal }
  }
}

describe('AgentToolRegistry', () => {
  it('takes correlation from the prepared call and trusted run context, not arguments', async () => {
    const request = input('wait', {
      seconds: 1,
      toolCallId: 'argument-spoof',
      runId: 'argument-run'
    })
    const executor = vi.fn<AgentToolExecutor>(async () => ({}))
    await registry.execute(
      { ...request, context: { ...request.context, toolCallId: 'context-spoof' } },
      executor
    )
    expect(executor.mock.calls[0][1]).toMatchObject({ runId: 'run-1', toolCallId: 'call-1' })
    expect(request.context).not.toHaveProperty('toolCallId')
  })

  it('keeps distinct concurrent call IDs in private executor callbacks', async () => {
    const local = new AgentToolRegistry()
    const seen: Array<{ runId: string; toolCallId?: string }> = []
    const releases: Array<() => void> = []
    const run = (id: string) => {
      const request = input('tool_output', { handle: id })
      request.call.id = id
      return local.execute(request, async (_args, context) => {
        const observe = () => seen.push({ runId: context.runId, toolCallId: context.toolCallId })
        await new Promise<void>((resolve) => releases.push(resolve))
        observe()
        return {}
      })
    }
    const first = run('first')
    const second = run('second')
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    releases[0]()
    await Promise.all([first, second])
    expect(seen).toEqual([
      { runId: 'run-1', toolCallId: 'second' },
      { runId: 'run-1', toolCallId: 'first' }
    ])
  })

  it('snapshots queued correlation despite caller context and call mutation', async () => {
    const local = new AgentToolRegistry()
    let release!: () => void
    const blocking = local.execute(input('wait', { seconds: 1 }), async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const request = input('wait', { seconds: 1 })
    request.call.id = 'queued-call'
    const executor = vi.fn<AgentToolExecutor>(async () => ({}))
    const pending = local.execute(request, executor)
    request.context.runId = 'changed-run'
    request.call.id = 'changed-call'
    release()
    await Promise.all([blocking, pending])
    expect(executor.mock.calls[0][1]).toMatchObject({ runId: 'run-1', toolCallId: 'queued-call' })
  })

  it('does not invent correlation for direct handler invocations', async () => {
    const handlers = new AgentToolHandlerRegistry()
    const observe = vi.fn()
    handlers.register('direct', async ({ context }) => {
      observe(context)
      return toolExecutionSucceeded({ title: 'Direct', data: {} })
    })
    await handlers.execute({
      name: 'direct',
      title: 'Direct',
      arguments: { toolCallId: 'spoof' },
      context: { runId: 'internal', signal: new AbortController().signal }
    })
    expect(observe.mock.calls[0][0]).not.toHaveProperty('toolCallId')
  })

  it('rejects unavailable tools without calling an executor', async () => {
    const executor = vi.fn()
    const result = await registry.execute(input('not_a_tool', {}), executor)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('unknown_tool')
    expect(executor).not.toHaveBeenCalled()
  })

  it('validates required arguments before side effects', async () => {
    const executor = vi.fn()
    const missing = await registry.execute(input('shell', {}), executor)
    expect(missing.error?.code).toBe('invalid_arguments')
    expect(missing.error?.recoveryAction).toBe('correct_input')
    expect(missing.error?.message).toContain('command')
    expect(executor).not.toHaveBeenCalled()
  })

  it('reports all nested schema errors in one model-visible result', async () => {
    const executor = vi.fn()
    const result = await registry.execute(
      input('ask_user', {
        questions: [
          { question: 'First?' },
          { id: 'second' },
          { id: 'third', question: 'Third?' },
          { id: 'fourth', question: 'Fourth?' }
        ]
      }),
      executor
    )

    expect(result.error?.message).toContain('questions[0].id')
    expect(result.error?.message).toContain('questions[1].question')
    expect(result.error?.message).toContain('at most 3')
    expect(executor).not.toHaveBeenCalled()
  })

  it('rejects removed model-specific editing aliases', async () => {
    const executor = vi.fn(async () => ({ changed: true }))
    const result = await registry.execute(
      input(
        'EDIT',
        {
          filePath: 'src/app.ts',
          oldText: 'before',
          newText: 'after',
          replaceAll: 'false',
          access_level: 'auto'
        },
        new AbortController().signal,
        {
          surface: 'conversation' as const,
          workspaceRoot: '/project'
        }
      ),
      executor
    )

    expect(result).toMatchObject({ status: 'error', error: { code: 'unknown_tool' } })
    expect(executor).not.toHaveBeenCalled()
  })

  it('normalizes successful values and typed permission denials', async () => {
    const success = await registry.execute(input('wait', { seconds: 1 }), async () => ({
      waitedSeconds: 1
    }))
    expect(success).toMatchObject({ status: 'success', data: { waitedSeconds: 1 } })

    const denied = await registry.execute(input('wait', { seconds: 1 }), async () => {
      throw new AgentToolExecutionError('permission_denied', 'Denied by user')
    })
    expect(denied.status).toBe('denied')
    expect(denied.error?.code).toBe('permission_denied')
  })

  it('does not enter the executor after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const executor = vi.fn()
    const result = await registry.execute(
      input('wait', { seconds: 1 }, controller.signal),
      executor
    )
    expect(result.status).toBe('cancelled')
    expect(executor).not.toHaveBeenCalled()
  })

  it('classifies missing filesystem resources as recoverable not-found errors', async () => {
    const result = await registry.execute(input('wait', { seconds: 1 }), async () => {
      throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' })
    })
    expect(result).toMatchObject({ status: 'error', error: { code: 'not_found', retryable: true } })
  })

  it('settles cancellation when an executor ignores AbortSignal', async () => {
    const controller = new AbortController()
    let releaseExecutor!: () => void
    const executor = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseExecutor = () => resolve({ waitedSeconds: 1 })
        })
    )
    const executing = registry.execute(input('wait', { seconds: 1 }, controller.signal), executor)

    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce())
    controller.abort()

    await expect(
      Promise.race([executing, new Promise((resolve) => setTimeout(resolve, 100))])
    ).resolves.toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } })
    releaseExecutor()
  })

  it('runs parallel reads together and waits before exclusive execution', async () => {
    const localRegistry = new AgentToolRegistry()
    const releases: Array<() => void> = []
    const started: string[] = []
    const read = (label: string) =>
      localRegistry.execute(input('tool_output', { handle: label }), async () => {
        started.push(label)
        await new Promise<void>((resolve) => releases.push(resolve))
        return { content: label }
      })
    const first = read('first')
    const second = read('second')
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']))

    const exclusive = localRegistry.execute(input('shell', { command: 'echo ok' }), async () => {
      started.push('exclusive')
      return { stdout: 'ok' }
    })
    await Promise.resolve()
    expect(started).not.toContain('exclusive')

    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second, exclusive])
    expect(started.at(-1)).toBe('exclusive')
  })
})
