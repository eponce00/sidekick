import type { VoiceAPI } from '../../../../shared/voice'
import { voicePreferences } from './voicePreferences'

export type SpeechPlayback = { status: 'idle' } | { status: 'loading' | 'playing'; key: string }

type Listener = (playback: SpeechPlayback) => void

function randomId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * Reads one reply aloud at a time. Audio arrives from the local model a
 * sentence at a time and is scheduled back to back, so playback starts with
 * the first sentence rather than after the whole reply is generated.
 */
export class SpeechPlayer {
  private playback: SpeechPlayback = { status: 'idle' }
  private readonly listeners = new Set<Listener>()
  private context?: AudioContext
  private sources = new Set<AudioBufferSourceNode>()
  private speechId?: string
  private nextStart = 0
  private generationDone = false
  private unsubscribe: Array<() => void> = []

  constructor(private readonly api: () => VoiceAPI | undefined) {}

  current(): SpeechPlayback {
    return this.playback
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(playback: SpeechPlayback): void {
    this.playback = playback
    for (const listener of this.listeners) listener(playback)
  }

  /** Starts reading `text` for `key`, or stops if `key` is already being read. */
  async toggle(key: string, text: string): Promise<string | undefined> {
    const playingThis = this.playback.status !== 'idle' && this.playback.key === key
    this.stop()
    if (playingThis) return undefined
    const api = this.api()
    if (!api) return 'Read aloud is unavailable here.'
    const speechId = randomId()
    this.speechId = speechId
    this.generationDone = false
    this.set({ status: 'loading', key })
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
    const preferences = voicePreferences()
    await this.route(preferences.outputDeviceId)
    this.nextStart = 0
    this.unsubscribe = [
      api.onSpeechAudio((event) => {
        if (event.speechId === this.speechId) this.enqueue(event.samples, event.sampleRate, key)
      }),
      api.onSpeechEnd((event) => {
        if (event.speechId !== this.speechId) return
        this.generationDone = true
        if (event.error || !this.sources.size) this.finish()
      })
    ]
    const result = await api.speak(speechId, text, {
      voice: preferences.voice,
      language: preferences.language
    })
    if (!result.ok) {
      if (this.speechId === speechId) this.finish()
      return result.message
    }
    return undefined
  }

  /** Plays through the chosen speaker; an unplugged one falls back to the default. */
  private async route(deviceId: string): Promise<void> {
    const context = this.context as
      | (AudioContext & {
          sinkId?: string | object
          setSinkId?: (id: string) => Promise<void>
        })
      | undefined
    if (!context?.setSinkId || context.sinkId === deviceId) return
    await context.setSinkId(deviceId).catch(() => context.setSinkId!('').catch(() => undefined))
  }

  private enqueue(samples: Float32Array, sampleRate: number, key: string): void {
    const context = this.context
    if (!context || !samples.length) return
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(new Float32Array(samples), 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const start = Math.max(context.currentTime + 0.05, this.nextStart)
    source.start(start)
    this.nextStart = start + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      if (this.generationDone && !this.sources.size) this.finish()
    }
    if (this.playback.status === 'loading') this.set({ status: 'playing', key })
  }

  private finish(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.unsubscribe = []
    this.speechId = undefined
    this.set({ status: 'idle' })
  }

  stop(): void {
    const speechId = this.speechId
    if (speechId) void this.api()?.stopSpeech(speechId)
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already ended.
      }
    }
    this.sources.clear()
    if (this.playback.status !== 'idle' || speechId) this.finish()
  }
}

export const speechPlayer = new SpeechPlayer(() =>
  typeof window !== 'undefined' ? window.api?.voice : undefined
)
