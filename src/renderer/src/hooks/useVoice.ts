import { useSyncExternalStore } from 'react'
import type { VoiceState } from '../../../shared/voice'
import { speechPlayer, type SpeechPlayback } from '../services/voice/speechPlayer'

// One subscription to the main process serves every button that shows voice
// state; a long chat has a read-aloud button per reply.
let voiceState: VoiceState | undefined
let voiceSubscription: (() => void) | undefined
const voiceListeners = new Set<() => void>()

function subscribeVoice(listener: () => void): () => void {
  voiceListeners.add(listener)
  const api = typeof window !== 'undefined' ? window.api?.voice : undefined
  if (api && !voiceSubscription) {
    const update = (next: VoiceState): void => {
      voiceState = next
      for (const notify of voiceListeners) notify()
    }
    voiceSubscription = api.onState(update)
    void api.getState().then(update)
  }
  return () => {
    voiceListeners.delete(listener)
    if (!voiceListeners.size && voiceSubscription) {
      voiceSubscription()
      voiceSubscription = undefined
    }
  }
}

/** Live voice model state; undefined until loaded or where voice is unavailable. */
export function useVoiceState(): VoiceState | undefined {
  return useSyncExternalStore(subscribeVoice, () => voiceState)
}

export function useSpeechPlayback(): SpeechPlayback {
  return useSyncExternalStore(
    (listener) => speechPlayer.subscribe(listener),
    () => speechPlayer.current()
  )
}
