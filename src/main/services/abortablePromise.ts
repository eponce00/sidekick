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
  if (signal.aborted) return Promise.reject(abortError(message))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(message))
    signal.addEventListener('abort', abort, { once: true })
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
  })
}
