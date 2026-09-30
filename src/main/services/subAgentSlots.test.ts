import { describe, expect, it, vi } from 'vitest'
import { SubAgentSlots } from './subAgentSlots'

describe('SubAgentSlots', () => {
  it('runs up to the limit at once and hands the next slot over in order', async () => {
    const slots = new SubAgentSlots()
    const signal = new AbortController().signal
    const queued = vi.fn()
    const first = await slots.acquire('server', 2, signal, queued)
    const second = await slots.acquire('server', 2, signal, queued)
    expect(queued).not.toHaveBeenCalled()

    const order: string[] = []
    const third = slots.acquire('server', 2, signal, () => order.push('third queued'))
    const fourth = slots.acquire('server', 2, signal, () => order.push('fourth queued'))
    void third.then(() => order.push('third started'))
    void fourth.then(() => order.push('fourth started'))
    await Promise.resolve()
    expect(order).toEqual(['third queued', 'fourth queued'])

    first()
    await third
    second()
    await fourth
    expect(order).toEqual(['third queued', 'fourth queued', 'third started', 'fourth started'])
  })

  it('keeps each provider to its own limit', async () => {
    const slots = new SubAgentSlots()
    const signal = new AbortController().signal
    const queued = vi.fn()
    await slots.acquire('local', 1, signal, queued)
    await slots.acquire('cloud', 1, signal, queued)
    expect(queued).not.toHaveBeenCalled()
  })

  it('gives up a queued place when stopped, without holding the slot', async () => {
    const slots = new SubAgentSlots()
    const running = await slots.acquire('server', 1, new AbortController().signal)
    const controller = new AbortController()
    const waiting = slots.acquire('server', 1, controller.signal)
    controller.abort(new Error('Stopped'))
    await expect(waiting).rejects.toThrow('Stopped')

    running()
    // The abandoned place did not take the freed slot.
    const next = vi.fn()
    await slots.acquire('server', 1, new AbortController().signal, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('releases once, however often release is called', async () => {
    const slots = new SubAgentSlots()
    const signal = new AbortController().signal
    const release = await slots.acquire('server', 1, signal)
    release()
    release()
    await slots.acquire('server', 1, signal)
    const queued = vi.fn()
    void slots.acquire('server', 1, signal, queued)
    expect(queued).toHaveBeenCalledOnce()
  })
})
