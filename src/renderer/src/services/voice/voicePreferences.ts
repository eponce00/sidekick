import { useSyncExternalStore } from 'react'
import {
  DEFAULT_SPEECH_VOICE,
  isSpeechLanguage,
  SPEECH_VOICES,
  type SpeechLanguageCode
} from '../../../../shared/voice'

/**
 * How voice sounds and which devices it uses on this machine. Device ids only
 * mean something here, so these live in this machine's storage and apply as
 * soon as they are chosen. Empty device ids mean the system default.
 */
export interface VoicePreferences {
  inputDeviceId: string
  outputDeviceId: string
  voice: number
  language: SpeechLanguageCode | 'auto'
}

const KEY = 'sidekick.voice.preferences'
const DEFAULTS: VoicePreferences = {
  inputDeviceId: '',
  outputDeviceId: '',
  voice: DEFAULT_SPEECH_VOICE,
  language: 'auto'
}
const listeners = new Set<() => void>()
let cached: VoicePreferences | undefined

function read(): VoicePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePreferences>
    return {
      inputDeviceId: typeof stored.inputDeviceId === 'string' ? stored.inputDeviceId : '',
      outputDeviceId: typeof stored.outputDeviceId === 'string' ? stored.outputDeviceId : '',
      voice:
        Number.isInteger(stored.voice) && stored.voice! >= 0 && stored.voice! < SPEECH_VOICES.length
          ? stored.voice!
          : DEFAULTS.voice,
      language: isSpeechLanguage(stored.language) ? stored.language : 'auto'
    }
  } catch {
    return DEFAULTS
  }
}

export function voicePreferences(): VoicePreferences {
  cached ??= read()
  return cached
}

export function updateVoicePreferences(patch: Partial<VoicePreferences>): void {
  cached = { ...voicePreferences(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    // Unavailable storage keeps the choice for this session only.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVoicePreferences(): VoicePreferences {
  return useSyncExternalStore(subscribe, voicePreferences)
}
