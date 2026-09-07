function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * Stops awaiting work as soon as its owning run is cancelled, even when an
 * external provider or tool adapter fails to observe AbortSignal itself.
 * The original promise remains observed so a late rejection cannot become an
 * unhandled rejection.
 */
export function abortablePromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message = 'Operation cancelled'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(abortError(message))
    }
    // Always observe the supplied promise, even when it was created before an
    // already-aborted signal was checked. Late rejection must remain handled.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
