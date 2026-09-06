import { expect, it, vi } from 'vitest'
import { cancelProviderStreamReader, releaseProviderStreamReader } from './providerStreamReader'

it('accepts a missing reader on a pre-fetch or response failure', () => {
  expect(() => cancelProviderStreamReader(undefined)).not.toThrow()
  expect(() => releaseProviderStreamReader(undefined)).not.toThrow()
})

it('attempts lock release even if transport cancellation throws synchronously', () => {
  const reader = {
    cancel: vi.fn(() => {
      throw new Error('cancel failed')
    }),
    releaseLock: vi.fn(() => {
      throw new Error('release failed')
    })
  }
  expect(() => releaseProviderStreamReader(reader)).not.toThrow()
  expect(reader.cancel).toHaveBeenCalledOnce()
  expect(reader.releaseLock).toHaveBeenCalledOnce()
})

it('does not wait on hung cancellation and observes its eventual rejection', async () => {
  let reject!: (reason: Error) => void
  const reader = {
    cancel: vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    ),
    releaseLock: vi.fn()
  }
  expect(releaseProviderStreamReader(reader)).toBeUndefined()
  expect(reader.releaseLock).toHaveBeenCalledOnce()
  reject(new Error('late cleanup failure'))
  await new Promise((resolve) => setImmediate(resolve))
})

it('cancels without releasing a lock that the active read loop still owns', () => {
  const reader = { cancel: vi.fn(async () => undefined), releaseLock: vi.fn() }
  cancelProviderStreamReader(reader)
  expect(reader.cancel).toHaveBeenCalledOnce()
  expect(reader.releaseLock).not.toHaveBeenCalled()
})
