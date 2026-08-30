import { describe, expect, it, vi } from 'vitest'
import { ToolExecutionPipeline, ToolRuntimeTimeoutError } from './toolExecutionPipeline'

describe('ToolExecutionPipeline', () => {
  it('freezes a canonical argument snapshot before guards and execution', async () => {
    const pipeline = new ToolExecutionPipeline()
    const seen: Readonly<Record<string, unknown>>[] = []
    pipeline.registerGuard((input) => {
      seen.push(input.arguments)
      return undefined
    })
    const args = { path: 'src/app.ts' }

    const result = await pipeline.execute({
      name: 'read',
      arguments: args,
      signal: new AbortController().signal,
      body: async () => 'ok'
    })
    args.path = 'changed-after-dispatch.ts'

    expect(result).toBe('ok')
    expect(seen[0]).toEqual({ path: 'src/app.ts' })
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('makes guard denial monotonic by stopping before the executor', async () => {
    const pipeline = new ToolExecutionPipeline()
    const laterGuard = vi.fn()
    pipeline.registerGuard(() => 'workspace policy denied this call')
    pipeline.registerGuard(laterGuard)
    const body = vi.fn()

    await expect(
      pipeline.execute({
        name: 'shell',
        arguments: { command: 'pwd' },
        signal: new AbortController().signal,
        body
      })
    ).rejects.toThrow('workspace policy denied this call')
    expect(laterGuard).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('settles with a typed timeout even when same-process code ignores cancellation', async () => {
    const pipeline = new ToolExecutionPipeline()
    let release!: () => void
    const execution = pipeline.execute({
      name: 'read',
      arguments: { path: 'slow.txt' },
      signal: new AbortController().signal,
      timeoutMs: 10,
      body: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('late')
        })
    })

    await expect(execution).rejects.toBeInstanceOf(ToolRuntimeTimeoutError)
    release()
  })

  it('runs the extensible lifecycle in a deterministic nesting order', async () => {
    const pipeline = new ToolExecutionPipeline()
    const order: string[] = []
    pipeline.registerBefore(() => {
      order.push('before')
    })
    pipeline.registerGuard(() => {
      order.push('guard')
      return undefined
    })
    pipeline.registerAround(async (_input, next) => {
      order.push('around:before')
      const result = await next()
      order.push('around:after')
      return result
    })
    pipeline.registerAfter<string>((_input, result) => {
      order.push('after')
      return `${String(result)}!`
    })

    const result = await pipeline.execute({
      name: 'read',
      arguments: {},
      signal: new AbortController().signal,
      body: async () => {
        order.push('body')
        return 'ok'
      }
    })

    expect(result).toBe('ok!')
    expect(order).toEqual(['before', 'guard', 'around:before', 'body', 'around:after', 'after'])
  })
})
