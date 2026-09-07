import { describe, expect, it, vi } from 'vitest'
import { readBoundedRequestBody, RequestBodyTooLargeError } from './boundedRequestBody'

function streamedRequest(
  chunks: Uint8Array[],
  headers?: HeadersInit,
  signal?: AbortSignal,
  cancel = vi.fn(async () => {})
): { request: Request; cancel: typeof cancel; pulls: () => number } {
  let index = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else controller.close()
      },
      cancel
    },
    { highWaterMark: 0 }
  )
  const request = new Request('https://fixture.invalid/save', {
    method: 'POST',
    body,
    headers,
    signal,
    duplex: 'half'
  } as RequestInit)
  return { request, cancel, pulls: () => index }
}

describe('bounded request-body streaming', () => {
  it.each(['request', 'owner'] as const)(
    'preserves independent %s cancellation when an owning signal is supplied',
    async (cancelledScope) => {
      const requestController = new AbortController()
      const ownerController = new AbortController()
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      const request = new Request('https://fixture.invalid/save', {
        method: 'POST',
        body,
        signal: requestController.signal,
        duplex: 'half'
      } as RequestInit)
      const pending = readBoundedRequestBody(request, 8, ownerController.signal)
      const cancelled = cancelledScope === 'request' ? requestController : ownerController
      const other = cancelledScope === 'request' ? ownerController : requestController
      cancelled.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(other.signal.aborted).toBe(false)
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    }
  )

  it('does not mask a pre-aborted request with a live owning signal', async () => {
    const requestController = new AbortController()
    requestController.abort()
    const ownerController = new AbortController()
    const fixture = streamedRequest([Buffer.from('unread')], undefined, requestController.signal)
    await expect(
      readBoundedRequestBody(fixture.request, 8, ownerController.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.pulls()).toBe(0)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(ownerController.signal.aborted).toBe(false)
  })

  it.each([undefined, { 'content-length': '1' }, { 'content-length': 'invalid' }])(
    'stops on actual overflow independently of length header %s',
    async (headers) => {
      const fixture = streamedRequest(
        [Buffer.from('1234'), Buffer.from('5678'), Buffer.from('9'), Buffer.from('unread')],
        headers
      )
      const arrayBuffer = vi.spyOn(fixture.request, 'arrayBuffer')
      await expect(readBoundedRequestBody(fixture.request, 8)).rejects.toBeInstanceOf(
        RequestBodyTooLargeError
      )
      expect(fixture.pulls()).toBe(3)
      expect(fixture.cancel).toHaveBeenCalledOnce()
      expect(fixture.request.body?.locked).toBe(false)
      expect(arrayBuffer).not.toHaveBeenCalled()
    }
  )

  it('rejects an oversized declared body without consuming its first chunk', async () => {
    const fixture = streamedRequest([Buffer.from('unread')], { 'content-length': '9' })
    await expect(readBoundedRequestBody(fixture.request, 8)).rejects.toThrow('8-byte limit')
    expect(fixture.pulls()).toBe(0)
    expect(fixture.cancel).toHaveBeenCalledOnce()
  })

  it('accepts the exact boundary and empty chunks without changing bytes', async () => {
    const fixture = streamedRequest([Buffer.from('1234'), Buffer.alloc(0), Buffer.from('5678')])
    expect(await readBoundedRequestBody(fixture.request, 8)).toEqual(Buffer.from('12345678'))
    expect(fixture.cancel).not.toHaveBeenCalled()
    expect(fixture.request.body?.locked).toBe(false)
  })

  it('returns an empty body and validates the configured budget', async () => {
    const request = new Request('https://fixture.invalid/save', { method: 'POST' })
    expect(await readBoundedRequestBody(request, 0)).toEqual(Buffer.alloc(0))
    for (const limit of [-1, NaN, Infinity, 0.5]) {
      await expect(readBoundedRequestBody(request, limit)).rejects.toThrow('safe integer')
    }
  })

  it('does not wait for a transport whose overflow cancellation never settles', async () => {
    const fixture = streamedRequest(
      [Buffer.from('oversized')],
      undefined,
      undefined,
      vi.fn(() => new Promise<void>(() => {}))
    )
    await expect(readBoundedRequestBody(fixture.request, 1)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    )
    expect(fixture.request.body?.locked).toBe(false)
  })

  it('cancels an already-aborted body without reading a chunk', async () => {
    const controller = new AbortController()
    controller.abort()
    const fixture = streamedRequest([Buffer.from('unread')], undefined, controller.signal)
    await expect(readBoundedRequestBody(fixture.request, 8)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fixture.pulls()).toBe(0)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.request.body?.locked).toBe(false)
  })

  it('copies accepted chunks before a producer reuses its backing buffer', async () => {
    const bytes = new Uint8Array([1, 2])
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(bytes)
          else {
            bytes.fill(9)
            controller.close()
          }
        }
      },
      { highWaterMark: 0 }
    )
    const request = new Request('https://fixture.invalid/save', {
      method: 'POST',
      body,
      duplex: 'half'
    } as RequestInit)
    expect(await readBoundedRequestBody(request, 2)).toEqual(Buffer.from([1, 2]))
  })

  it('aborts an unresolved read and observes late transport cleanup failure', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => {
      throw new Error('late transport cleanup failure')
    })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const request = new Request('https://fixture.invalid/save', {
      method: 'POST',
      body,
      signal: controller.signal,
      duplex: 'half'
    } as RequestInit)
    const result = readBoundedRequestBody(request, 8)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('preserves a stream read failure and releases the lock', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('synthetic read failure'))
      }
    })
    const request = new Request('https://fixture.invalid/save', {
      method: 'POST',
      body,
      duplex: 'half'
    } as RequestInit)
    await expect(readBoundedRequestBody(request, 8)).rejects.toThrow('synthetic read failure')
    expect(body.locked).toBe(false)
  })
})
