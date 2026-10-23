import { useSyncExternalStore } from 'react'
import type { CompanionEvent, CompanionVoiceState } from '../../../shared/companion'
import type {
  VoiceAPI,
  VoiceModelState,
  VoiceSpeechAudio,
  VoiceSpeechEnd,
  VoiceState
} from '../../../shared/voice'
import { base64ToBytes, pcm16ToFloat32 } from './audio'
import type { CompanionConnection } from './chatState'

/**
 * The computer's voice as the phone uses it. Read aloud plays here what the computer speaks, so
 * the desktop's read-aloud button and player work unchanged; dictation records here and the
 * computer transcribes.
 */

let current: CompanionVoiceState | null = null
const stateListeners = new Set<() => void>()
const audioListeners = new Set<(event: VoiceSpeechAudio) => void>()
const endListeners = new Set<(event: VoiceSpeechEnd) => void>()

function setVoice(next: CompanionVoiceState | null): void {
  current = next
  for (const listener of stateListeners) listener()
}

/** The desktop's voice state for what the computer offers the phone. */
export function voiceStateFor(state: CompanionVoiceState | null): VoiceState {
  const model = (ready: boolean): VoiceModelState => ({
    status: ready ? 'ready' : 'missing',
    receivedBytes: 0,
    totalBytes: 0
  })
  return {
    // The desktop's switch covers both; here read aloud shows only where it can play.
    enabled: Boolean(state?.speech),
    models: { dictation: model(Boolean(state?.dictation)), speech: model(Boolean(state?.speech)) }
  }
}

/** Asks the computer what voice it offers; nothing is offered while it cannot say. */
export async function refreshPhoneVoice(connection: CompanionConnection | null): Promise<void> {
  if (!connection) {
    setVoice(null)
    return
  }
  try {
    setVoice(await connection.call('voice.state', {}))
  } catch {
    setVoice(null)
  }
}

/** Speech the computer sent this phone, for the player that asked for it. */
export function dispatchVoiceEvent(event: CompanionEvent): void {
  if (event.type === 'speech.audio') {
    let samples: Float32Array
    try {
      samples = pcm16ToFloat32(base64ToBytes(event.pcm))
    } catch {
      return
    }
    for (const listener of audioListeners)
      listener({ speechId: event.speechId, sampleRate: event.sampleRate, samples })
  } else if (event.type === 'speech.end') {
    for (const listener of endListeners)
      listener({ speechId: event.speechId, ...(event.error ? { error: event.error } : {}) })
  }
}

export function useCompanionVoice(): CompanionVoiceState | null {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    () => current
  )
}

const UNAVAILABLE = {
  ok: false,
  reason: 'unavailable',
  message: 'Not available on the phone.'
} as const

/** The desktop's voice API, backed by the computer. */
export function createPhoneVoice(connection: () => CompanionConnection | null): VoiceAPI {
  // The desktop's components subscribe to the full state; derived once per change.
  let derived = voiceStateFor(current)
  let derivedFrom = current
  const desktopState = (): VoiceState => {
    if (derivedFrom !== current) {
      derived = voiceStateFor(current)
      derivedFrom = current
    }
    return derived
  }
  return {
    getState: async () => desktopState(),
    onState: (callback) => {
      const listener = (): void => callback(desktopState())
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    prioritize: async () => undefined,
    startDictation: async () => UNAVAILABLE,
    pushDictationAudio: () => undefined,
    stopDictation: async () => undefined,
    cancelDictation: async () => undefined,
    onDictationText: () => () => undefined,
    speak: async (speechId, text) => {
      const link = connection()
      if (!link)
        return { ok: false, reason: 'unavailable', message: 'The computer is not connected.' }
      try {
        const result = await link.call('voice.speak', { speechId, text })
        return result.ok
          ? { ok: true }
          : {
              ok: false,
              reason: 'unavailable',
              message: result.message ?? 'Read aloud is not available on the computer.'
            }
      } catch (error) {
        return {
          ok: false,
          reason: 'unavailable',
          message: error instanceof Error ? error.message : 'Read aloud did not start.'
        }
      }
    },
    stopSpeech: async (speechId) => {
      await connection()
        ?.call('voice.stop', { speechId })
        .catch(() => undefined)
    },
    onSpeechAudio: (callback) => {
      audioListeners.add(callback)
      return () => {
        audioListeners.delete(callback)
      }
    },
    onSpeechEnd: (callback) => {
      endListeners.add(callback)
      return () => {
        endListeners.delete(callback)
      }
    }
  }
}
