import { useSyncExternalStore } from 'react'
import {
  COMPANION_DICTATION_PIECE_SAMPLES,
  type CompanionEvent,
  type CompanionVoiceState
} from '../../../shared/companion'
import type {
  VoiceAPI,
  VoiceDictationText,
  VoiceModelState,
  VoiceSpeechAudio,
  VoiceSpeechEnd,
  VoiceState
} from '../../../shared/voice'
import { base64ToBytes, bytesToBase64, float32ToPcm16, pcm16ToFloat32 } from './audio'
import type { CompanionConnection } from './chatState'

/**
 * The computer's voice as the phone uses it, behind the desktop's voice API, so the desktop's
 * microphone button, read-aloud button and player work unchanged. Read aloud plays here what the
 * computer speaks; dictation streams this phone's microphone to the computer, which writes the
 * words back as they are spoken.
 */

let current: CompanionVoiceState | null = null
const stateListeners = new Set<() => void>()
const audioListeners = new Set<(event: VoiceSpeechAudio) => void>()
const endListeners = new Set<(event: VoiceSpeechEnd) => void>()
const textListeners = new Set<(event: VoiceDictationText) => void>()
/** Stops waiting for each dictation's last words. */
const dictationEnds = new Map<string, () => void>()
/** How long a stop waits for the last words from a computer that stopped answering. */
const DICTATION_END_MS = 10_000

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
    // The desktop's switch covers both; one the computer cannot offer yet shows as being set up.
    enabled: Boolean(state?.speech || state?.dictation),
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
  } else if (event.type === 'dictation.text') {
    for (const listener of textListeners)
      listener({ sessionId: event.dictationId, text: event.text, final: event.final })
  } else if (event.type === 'dictation.end') {
    dictationEnds.get(event.dictationId)?.()
  }
}

/**
 * One dictation's microphone, sent in order, one call at a time. What the microphone delivers
 * while a call is on its way goes in the next one, so a slow network sends fewer, larger pieces
 * rather than falling behind.
 */
class DictationUplink {
  private waiting: Float32Array[] = []
  private sending: Promise<void> | null = null
  private open = true

  constructor(
    private readonly dictationId: string,
    private readonly connection: () => CompanionConnection | null
  ) {}

  push(samples: Float32Array): void {
    if (!this.open || !samples.length) return
    this.waiting.push(samples)
    this.sending ??= this.send().finally(() => {
      this.sending = null
    })
  }

  /** Resolves once everything pushed so far was sent. */
  async flush(): Promise<void> {
    while (this.sending) await this.sending
  }

  close(): void {
    this.open = false
    this.waiting = []
  }

  private take(): Float32Array {
    let length = 0
    let count = 0
    while (
      count < this.waiting.length &&
      length + this.waiting[count].length <= COMPANION_DICTATION_PIECE_SAMPLES
    )
      length += this.waiting[count++].length
    // A frame longer than a piece goes in parts.
    if (!count) {
      const first = this.waiting[0]
      this.waiting[0] = first.subarray(COMPANION_DICTATION_PIECE_SAMPLES)
      return first.subarray(0, COMPANION_DICTATION_PIECE_SAMPLES)
    }
    const piece = new Float32Array(length)
    let offset = 0
    for (const frame of this.waiting.splice(0, count)) {
      piece.set(frame, offset)
      offset += frame.length
    }
    return piece
  }

  private async send(): Promise<void> {
    while (this.open && this.waiting.length) {
      const link = this.connection()
      if (!link) return this.close()
      const pcm = bytesToBase64(float32ToPcm16(this.take()))
      try {
        const { accepted } = await link.call('voice.dictation.audio', {
          dictationId: this.dictationId,
          pcm
        })
        // The computer ended the dictation; what it heard is already in the box.
        if (!accepted) this.close()
      } catch {
        this.close()
      }
    }
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

const NOT_CONNECTED = {
  ok: false,
  reason: 'unavailable',
  message: 'The computer is not connected.'
} as const

/** The desktop's voice API, backed by the computer. */
export function createPhoneVoice(connection: () => CompanionConnection | null): VoiceAPI {
  const uplinks = new Map<string, DictationUplink>()
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
    startDictation: async (sessionId) => {
      const link = connection()
      if (!link) return NOT_CONNECTED
      try {
        const result = await link.call('voice.dictation.start', { dictationId: sessionId })
        if (!result.ok)
          return {
            ok: false,
            reason: 'unavailable',
            message: result.message ?? 'Dictation is not available on the computer.'
          }
        uplinks.set(sessionId, new DictationUplink(sessionId, connection))
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          reason: 'unavailable',
          message: error instanceof Error ? error.message : 'Dictation did not start.'
        }
      }
    },
    pushDictationAudio: (sessionId, samples) => uplinks.get(sessionId)?.push(samples),
    stopDictation: async (sessionId) => {
      const uplink = uplinks.get(sessionId)
      uplinks.delete(sessionId)
      await uplink?.flush()
      // The last words come as events, ahead of the one that says they were all sent.
      const ended = new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          dictationEnds.delete(sessionId)
          resolve()
        }
        const timer = setTimeout(done, DICTATION_END_MS)
        dictationEnds.set(sessionId, done)
      })
      const link = connection()
      if (link)
        await link
          .call('voice.dictation.stop', { dictationId: sessionId })
          .catch(() => dictationEnds.get(sessionId)?.())
      else dictationEnds.get(sessionId)?.()
      await ended
    },
    cancelDictation: async (sessionId) => {
      uplinks.get(sessionId)?.close()
      uplinks.delete(sessionId)
      await connection()
        ?.call('voice.dictation.cancel', { dictationId: sessionId })
        .catch(() => undefined)
    },
    onDictationText: (callback) => {
      textListeners.add(callback)
      return () => {
        textListeners.delete(callback)
      }
    },
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
