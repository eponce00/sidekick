import { describe, expect, it, vi } from 'vitest'
import type { AgentToolCatalogOptions } from '../../shared/agentToolCatalog'
import { AgentToolExecutionError, AgentToolRegistry } from './agentToolRegistry'

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
