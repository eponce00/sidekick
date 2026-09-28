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

/** Supertonic 3's voices, in the order its voice file numbers them. */
export const SPEECH_VOICES = [
  'Female 1',
  'Female 2',
  'Female 3',
  'Female 4',
  'Female 5',
  'Male 1',
  'Male 2',
  'Male 3',
  'Male 4',
  'Male 5'
] as const

export const DEFAULT_SPEECH_VOICE = 6

/** Languages Supertonic 3 reads, named in their own language. */
export const SPEECH_LANGUAGES = {
  ar: 'العربية',
  bg: 'Български',
  cs: 'Čeština',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'Español',
  et: 'Eesti',
  fi: 'Suomi',
  fr: 'Français',
  hi: 'हिन्दी',
  hr: 'Hrvatski',
  hu: 'Magyar',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  sv: 'Svenska',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt'
} as const

export type SpeechLanguageCode = keyof typeof SPEECH_LANGUAGES

export interface SpeechOptions {
  /** Index into SPEECH_VOICES. */
  voice?: number
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
