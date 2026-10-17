/**
 * Local voice: dictation into the composer and read-aloud of replies. Both run
 * on this device with models SideKick downloads in the background.
 */

export type VoiceModelId = 'dictation' | 'speech'

export type VoiceModelStatus = 'missing' | 'queued' | 'downloading' | 'ready' | 'error'

export interface VoiceModelState {
  status: VoiceModelStatus
  receivedBytes: number
  totalBytes: number
  error?: string
}

export interface VoiceState {
  enabled: boolean
  models: Record<VoiceModelId, VoiceModelState>
}

export type VoiceStartResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'downloading' | 'unavailable'; message: string }

export interface VoiceDictationText {
  sessionId: string
  text: string
  /** False for a draft of the phrase still being spoken; the next text for it replaces it. */
  final: boolean
}

export interface VoiceSpeechAudio {
  speechId: string
  sampleRate: number
  samples: Float32Array
}

export interface VoiceSpeechEnd {
  speechId: string
  error?: string
}

export const VOICE_SAMPLE_RATE = 16_000

/**
 * The read-aloud voices: Kokoro v1.0's American English voices, by speaker id in its voices file.
 * The ones it rates best come first. A reply in another language is read by that language's own
 * Kokoro voice of the same gender (SPEECH_LANGUAGE_VOICES).
 */
export const SPEECH_VOICES = [
  { id: 'af_heart', speaker: 3, name: 'Heart', gender: 'female' },
  { id: 'af_bella', speaker: 2, name: 'Bella', gender: 'female' },
  { id: 'af_nicole', speaker: 6, name: 'Nicole', gender: 'female' },
  { id: 'af_sarah', speaker: 9, name: 'Sarah', gender: 'female' },
  { id: 'af_kore', speaker: 5, name: 'Kore', gender: 'female' },
  { id: 'am_michael', speaker: 16, name: 'Michael', gender: 'male' },
  { id: 'am_fenrir', speaker: 14, name: 'Fenrir', gender: 'male' },
  { id: 'am_puck', speaker: 18, name: 'Puck', gender: 'male' }
] as const

export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]['id']

export const DEFAULT_SPEECH_VOICE: SpeechVoiceId = 'af_heart'

export function isSpeechVoice(value: unknown): value is SpeechVoiceId {
  return SPEECH_VOICES.some(({ id }) => id === value)
}

/** Languages Kokoro reads, named in their own language. */
export const SPEECH_LANGUAGES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  it: 'Italiano',
  pt: 'Português'
} as const

export type SpeechLanguageCode = keyof typeof SPEECH_LANGUAGES

/**
 * Each language's own voices, by Kokoro speaker id, and the espeak-ng voice that turns its text
 * into sounds. French has only a female voice.
 */
export const SPEECH_LANGUAGE_VOICES: Record<
  Exclude<SpeechLanguageCode, 'en'>,
  { female: number; male: number; espeak: string }
> = {
  es: { female: 28, male: 29, espeak: 'es' },
  fr: { female: 30, male: 30, espeak: 'fr' },
  hi: { female: 31, male: 33, espeak: 'hi' },
  it: { female: 35, male: 36, espeak: 'it' },
  pt: { female: 42, male: 43, espeak: 'pt-br' }
}

export interface SpeechOptions {
  /** One of SPEECH_VOICES. */
  voice?: SpeechVoiceId
  /** A language to read in, or 'auto' to detect it from each reply. */
  language?: SpeechLanguageCode | 'auto'
}

export function isSpeechLanguage(value: unknown): value is SpeechLanguageCode {
  return typeof value === 'string' && Object.hasOwn(SPEECH_LANGUAGES, value)
}

export interface VoiceAPI {
  getState: () => Promise<VoiceState>
  onState: (callback: (state: VoiceState) => void) => () => void
  /** Moves a model the user reached for to the front of the background download. */
  prioritize: (id: VoiceModelId) => Promise<void>
  startDictation: (sessionId: string) => Promise<VoiceStartResult>
  pushDictationAudio: (sessionId: string, samples: Float32Array) => void
  /** Resolves once every stretch of speech recorded so far has been transcribed. */
  stopDictation: (sessionId: string) => Promise<void>
  cancelDictation: (sessionId: string) => Promise<void>
  onDictationText: (callback: (event: VoiceDictationText) => void) => () => void
  speak: (speechId: string, text: string, options?: SpeechOptions) => Promise<VoiceStartResult>
  stopSpeech: (speechId: string) => Promise<void>
  onSpeechAudio: (callback: (event: VoiceSpeechAudio) => void) => () => void
  onSpeechEnd: (callback: (event: VoiceSpeechEnd) => void) => () => void
}

/** Fraction of a model downloaded, 0 to 1. */
export function voiceModelProgress(state: VoiceModelState): number {
  if (state.status === 'ready') return 1
  return state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : 0
}
