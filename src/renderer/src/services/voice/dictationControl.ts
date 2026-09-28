// Lets the composer end a dictation it did not start: sending a message sends
// what is in the box and stops listening, so later words do not refill it.
let endActive: (() => void) | null = null

export function registerDictation(end: () => void): () => void {
  endActive = end
  return () => {
    if (endActive === end) endActive = null
  }
}

/** Stops the dictation in progress, dropping anything not yet in the box. */
export function endDictation(): void {
  endActive?.()
}
