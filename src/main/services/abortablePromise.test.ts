import { describe, expect, it, vi } from 'vitest'
import { abortablePromise } from './abortablePromise'

describe('abortablePromise ownership', () => {
  it('observes an already-rejected promise even when cancellation predates the call', async () => {
    const controller = new AbortController()
    controller.abort()
    const original = Promise.reject(new Error('late synthetic rejection'))
    const observe = vi.spyOn(original, 'then')
    await expect(abortablePromise(original, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(observe).toHaveBeenCalledOnce()
    // Vitest reports any unhandled rejection across these event-loop turns as a failure.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('removes its abort listener immediately and observes late rejection', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let reject!: (reason: Error) => void
    const original = new Promise<void>((_resolve, failure) => {
      reject = failure
    })
    const pending = abortablePromise(original, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    reject(new Error('late synthetic rejection'))
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('preserves normal fulfillment and failure while removing listeners', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(abortablePromise(Promise.resolve(7), controller.signal)).resolves.toBe(7)
    const error = new Error('synthetic failure')
    await expect(abortablePromise(Promise.reject(error), controller.signal)).rejects.toBe(error)
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
