import { describe, expect, it, vi } from 'vitest'
import {
  ToolExecutionPipeline,
  ToolRuntimeTimeoutError,
  whileWaitingForUser
} from './toolExecutionPipeline'

describe('ToolExecutionPipeline', () => {
  it.each(['before', 'after'] as const)(
    'bounds hanging %s hooks by the tool timeout',
    async (stage) => {
      const pipeline = new ToolExecutionPipeline()
      let release!: () => void
      const hanging = () =>
        new Promise<never>((resolve) => {
          release = () => resolve('late' as never)
        })
      if (stage === 'before') pipeline.registerBefore(hanging)
      else pipeline.registerAfter(hanging)
      const body = vi.fn(async () => 'ok')
      await expect(
        pipeline.execute({
          name: 'read',
          arguments: {},
          signal: new AbortController().signal,
          timeoutMs: 10,
          body
        })
      ).rejects.toBeInstanceOf(ToolRuntimeTimeoutError)
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(body).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1)
    }
  )

  it('does not run hooks for an already cancelled call', async () => {
    const pipeline = new ToolExecutionPipeline()
    const before = vi.fn()
    pipeline.registerBefore(before)
    await expect(
      pipeline.execute({
        name: 'read',
        arguments: {},
        signal: AbortSignal.abort(),
        body: async () => 'ok'
      })
    ).rejects.toThrow()
    expect(before).not.toHaveBeenCalled()
  })

  it('prevents an around hook from executing the side effect twice', async () => {
    const pipeline = new ToolExecutionPipeline()
    pipeline.registerAround(async (_input, next) => {
      await next()
      return next()
    })
    const body = vi.fn(async () => 'ok')
    await expect(
      pipeline.execute({ name: 'shell', arguments: {}, signal: new AbortController().signal, body })
    ).rejects.toThrow('only be invoked once')
    expect(body).toHaveBeenCalledOnce()
  })
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

  it('stops the time limit while the tool waits for the user', async () => {
    vi.useFakeTimers()
    try {
      const pipeline = new ToolExecutionPipeline()
      let answer!: (allowed: boolean) => void
      const execution = pipeline.execute({
        name: 'browser_navigate',
        arguments: { url: 'http://192.168.1.1' },
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        body: async () => {
          await vi.advanceTimersByTimeAsync(400)
          // An approval the user takes a minute to answer.
          const allowed = await whileWaitingForUser(
            () => new Promise<boolean>((resolve) => (answer = resolve))
          )
          return allowed ? 'opened' : 'denied'
        }
      })
      await vi.advanceTimersByTimeAsync(60_000)
      answer(true)
      await expect(execution).resolves.toBe('opened')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps counting the time spent before and after the wait', async () => {
    vi.useFakeTimers()
    try {
      const pipeline = new ToolExecutionPipeline()
      const execution = pipeline.execute({
        name: 'browser_navigate',
        arguments: {},
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        body: async () => {
          await new Promise((resolve) => setTimeout(resolve, 700))
          await whileWaitingForUser(() => new Promise((resolve) => setTimeout(resolve, 5_000)))
          // 700 ms were spent before the wait, so 300 more run out the limit.
          return new Promise<string>(() => undefined)
        }
      })
      let outcome: unknown
      execution.catch((error: unknown) => (outcome = error))
      // Had the wait counted, the limit would have run out a second in.
      await vi.advanceTimersByTimeAsync(700 + 5_000 + 250)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(100)
      expect(outcome).toBeInstanceOf(ToolRuntimeTimeoutError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits as usual outside a tool call', async () => {
    await expect(whileWaitingForUser(async () => 'answered')).resolves.toBe('answered')
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
