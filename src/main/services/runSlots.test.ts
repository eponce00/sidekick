import { describe, expect, it, vi } from 'vitest'
import { RunSlots, type RunSlotRequest } from './runSlots'

const signal = (): AbortSignal => new AbortController().signal

function request(
  runId: string,
  providerKey = 'server',
  providerLimit = 8,
  extra: Partial<RunSlotRequest> = {}
): RunSlotRequest {
  return {
    runId,
    conversationId: `chat-${runId}`,
    providerKey,
    providerLimit,
    signal: signal(),
    ...extra
  }
}

describe('RunSlots', () => {
  it('lends free slots to work that can wait, never ahead of a waiting run', async () => {
    const slots = new RunSlots(() => 1)
    const idle = slots.tryAcquire(request('idle'))!
    expect(idle).not.toBeNull()
    const run = slots.acquire(request('run'))
    expect(slots.tryAcquire(request('another'))).toBeNull()
    idle.release()
    await run
    expect(slots.tryAcquire(request('later'))).toBeNull()
  })

  it('runs up to the global limit and hands slots over in order', async () => {
    const slots = new RunSlots(() => 2)
    const first = await slots.acquire(request('a'))
    const second = await slots.acquire(request('b', 'cloud'))
    const order: string[] = []
    const third = slots.acquire(
      request('c', 'server', 8, { onQueued: () => order.push('c queued') })
    )
    const fourth = slots.acquire(
      request('d', 'cloud', 8, { onQueued: () => order.push('d queued') })
    )
    void third.then(() => order.push('c started'))
    void fourth.then(() => order.push('d started'))
    await Promise.resolve()
    expect(order).toEqual(['c queued', 'd queued'])
    expect(slots.queued().map(({ runId, conversationId }) => [runId, conversationId])).toEqual([
      ['c', 'chat-c'],
      ['d', 'chat-d']
    ])

    first.release()
    await third
    second.release()
    await fourth
    expect(order).toEqual(['c queued', 'd queued', 'c started', 'd started'])
    expect(slots.queued()).toEqual([])
  })

  it('keeps each provider to its own limit without holding back other providers', async () => {
    const slots = new RunSlots(() => 4)
    await slots.acquire(request('local-1', 'local', 1))
    const queued = vi.fn()
    const local = slots.acquire(request('local-2', 'local', 1, { onQueued: queued }))
    expect(queued).toHaveBeenCalledOnce()
    // A hosted run behind the waiting local one still starts at once.
    const hosted = vi.fn()
    await slots.acquire(request('cloud-1', 'cloud', 4, { onQueued: hosted }))
    expect(hosted).not.toHaveBeenCalled()
    expect(slots.inUse()).toEqual({ global: 2, providers: { local: 1, cloud: 1 } })
    void local
  })

  it('never holds a slot while waiting for another, so a full provider does not use up global slots', async () => {
    const slots = new RunSlots(() => 2)
    await slots.acquire(request('local-1', 'local', 1))
    void slots.acquire(request('local-2', 'local', 1))
    void slots.acquire(request('local-3', 'local', 1))
    expect(slots.inUse().global).toBe(1)
    const cloud = vi.fn()
    await slots.acquire(request('cloud-1', 'cloud', 4, { onQueued: cloud }))
    expect(cloud).not.toHaveBeenCalled()
  })

  it('gives up a queued place when stopped, and lets the next run through', async () => {
    const slots = new RunSlots(() => 1)
    const running = await slots.acquire(request('a'))
    const controller = new AbortController()
    const waiting = slots.acquire(request('b', 'server', 8, { signal: controller.signal }))
    const next = slots.acquire(request('c'))
    controller.abort(new Error('Stopped'))
    await expect(waiting).rejects.toThrow('Stopped')
    running.release()
    await next
    expect(slots.inUse().global).toBe(1)
  })

  it('gives slots back while suspended and waits its turn to resume', async () => {
    const slots = new RunSlots(() => 1)
    const parent = await slots.acquire(request('parent'))
    parent.suspend()
    expect(parent.held).toBe(false)
    // A sub-agent can run while its parent waits for it.
    const child = await slots.acquire(request('child'))
    const queued = vi.fn()
    const resumed = parent.resume(signal(), queued)
    expect(queued).toHaveBeenCalledOnce()
    expect(slots.queued()[0]).toMatchObject({ runId: 'parent', resuming: true })
    child.release()
    await resumed
    expect(parent.held).toBe(true)
    parent.release()
    parent.release()
    expect(slots.inUse()).toEqual({ global: 0, providers: {} })
  })

  it('releases once, however often release is called, and resuming after release does nothing', async () => {
    const slots = new RunSlots(() => 1)
    const lease = await slots.acquire(request('a'))
    lease.release()
    lease.release()
    await lease.resume(signal())
    expect(slots.inUse().global).toBe(0)
    await slots.acquire(request('b'))
    const queued = vi.fn()
    void slots.acquire(request('c', 'server', 8, { onQueued: queued }))
    expect(queued).toHaveBeenCalledOnce()
  })

  it('tells listeners when the queue changes', async () => {
    const slots = new RunSlots(() => 1)
    const listener = vi.fn()
    const unsubscribe = slots.subscribe(listener)
    const first = await slots.acquire(request('a'))
    const second = slots.acquire(request('b'))
    expect(listener).toHaveBeenCalledTimes(1)
    first.release()
    await second
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
