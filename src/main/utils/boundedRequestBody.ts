import { abortablePromise } from '../services/abortablePromise'

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`)
    this.name = 'RequestBodyTooLargeError'
  }
}

function cancelWithoutWaiting(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => undefined)
  } catch {
    // Transport cleanup must not replace the size or cancellation failure.
  }
}

/**
 * Bound retained bytes while reading, including absent or inaccurate length headers.
 * An optional owning signal adds cancellation; it never replaces request cancellation.
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
  ownerSignal?: AbortSignal
): Promise<Buffer> {
  const signal =
    ownerSignal && ownerSignal !== request.signal
      ? AbortSignal.any([request.signal, ownerSignal])
      : request.signal
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Request body limit must be a non-negative safe integer')
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > maxBytes) {
    if (request.body) cancelWithoutWaiting(() => request.body!.cancel())
    throw new RequestBodyTooLargeError(maxBytes)
  }
  if (signal.aborted) {
    if (request.body) cancelWithoutWaiting(() => request.body!.cancel())
    signal.throwIfAborted()
  }
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let completed = false
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await abortablePromise(reader.read(), signal)
      if (item.done) {
        completed = true
        return Buffer.concat(chunks, total)
      }
      if (item.value.byteLength > maxBytes - total) {
        throw new RequestBodyTooLargeError(maxBytes)
      }
      total += item.value.byteLength
      // Copy only after the bound check; do not retain a producer's mutable backing buffer.
      if (item.value.byteLength) chunks.push(Buffer.from(item.value))
    }
  } finally {
    if (!completed) cancelWithoutWaiting(() => reader.cancel())
    try {
      reader.releaseLock()
    } catch {
      // Preserve the original result if a custom transport refuses lock release.
    }
  }
}
