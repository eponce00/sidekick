import { useSyncExternalStore } from 'react'

/**
 * The message box's dictation, for what does not hold its button: sending a message ends it, so
 * later words do not refill the box, and the shortcut and the command palette turn it on and off.
 */
interface DictationControls {
  /** Stops at once, dropping anything not yet in the box. */
  end: () => void
  /** Starts listening, or stops and keeps what was heard. */
  toggle: () => void
}

let active: DictationControls | null = null
let listening = false
const listeners = new Set<() => void>()

export function registerDictation(controls: DictationControls): () => void {
  active = controls
  return () => {
    if (active === controls) active = null
  }
}

/** Stops the dictation in progress, dropping anything not yet in the box. */
export function endDictation(): void {
  active?.end()
}

/** Turns dictation on or off in the message box; false when there is none to turn. */
export function toggleDictation(): boolean {
  if (!active) return false
  active.toggle()
  return true
}

/** Set by the microphone button as it starts and stops listening. */
export function setDictating(next: boolean): void {
  if (next === listening) return
  listening = next
  for (const listener of listeners) listener()
}

export function useDictating(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => listening
  )
}
