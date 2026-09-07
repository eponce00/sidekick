type StreamReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel' | 'releaseLock'>

/** Cleanup is not another completion condition and cannot replace the turn's result. */
export function cancelProviderStreamReader(reader: StreamReader | undefined): void {
  try {
    if (reader) void reader.cancel().catch(() => undefined)
  } catch {
    // Custom transports can throw synchronously as well as reject asynchronously.
  }
}

export function releaseProviderStreamReader(reader: StreamReader | undefined): void {
  cancelProviderStreamReader(reader)
  try {
    reader?.releaseLock()
  } catch {
    // Keep the original success/failure even when best-effort cleanup fails.
  }
}
