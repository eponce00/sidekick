import type {
  VoiceModelId,
  VoiceModelState,
  VoiceStartResult,
  VoiceState
} from '../../../shared/voice'
import {
  DEFAULT_SPEECH_VOICE,
  isSpeechLanguage,
  SPEECH_VOICES,
  VOICE_SAMPLE_RATE,
  type SpeechOptions
} from '../../../shared/voice'
import { detectSpeechLanguage, speakableText } from '../../../shared/voiceText'
import { VOICE_MODELS, VoiceModelStore } from './voiceModels'

/** The slice of sherpa-onnx-node this service uses. */
export interface SherpaModule {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaRecognizer>
  }
  OfflineTts: {
    createAsync(config: unknown): Promise<SherpaTts>
  }
  GenerationConfig: new (options: Record<string, unknown>) => unknown
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad
}

interface SherpaRecognizer {
  createStream(): {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
  }
  decodeAsync(stream: ReturnType<SherpaRecognizer['createStream']>): Promise<{ text: string }>
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  /** Speech is going on now. */
  isDetected(): boolean
  front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number }
  pop(): void
  flush(): void
}

interface SherpaTts {
  sampleRate: number
  generateAsync(request: {
    text: string
    generationConfig: unknown
    enableExternalBuffer?: boolean
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void
  }): Promise<{ samples: Float32Array; sampleRate: number }>
}

export interface VoiceServiceOptions {
  store: VoiceModelStore
  enabled: boolean
  loadSherpa?: () => Promise<SherpaModule>
  /** Delay before the first background download, so startup is not competing with it. */
  startDelayMs?: number
  retryDelaysMs?: number[]
  idleUnloadMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

interface DictationSession {
  vad: SherpaVad
  audio: DictationAudio
  /** Sample index where the last transcribed stretch of speech ended. */
  transcribedUntil: number
  decoding: Promise<void>
  /** Decodes queued or running. */
  pending: number
  draftedAt: number
  /** A draft of the current phrase is showing. */
  drafting: boolean
  onText: (text: string, final: boolean) => void
}

const DRAFT_INTERVAL_MS = 600
// Drafts cover at most the last 20 s; the detector ends a phrase by 25 s.
const DRAFT_WINDOW = VOICE_SAMPLE_RATE * 20

// Silero marks speech about 0.4 s after a soft opening word begins ("The ...").
// The tail stays under the detector's 0.5 s silence gap, so it cannot reach
// into the next stretch.
const SEGMENT_LEAD_IN = Math.round(VOICE_SAMPLE_RATE * 0.6)
const SEGMENT_TAIL = Math.round(VOICE_SAMPLE_RATE * 0.3)

/**
 * The recent audio of a dictation, addressed by sample index from its start,
 * so a detected stretch can be read back with the moments around it. Only the
 * last minute is kept; a stretch of speech is at most 25 seconds.
 */
export class DictationAudio {
  private chunks: Float32Array[] = []
  private first = 0
  private length = 0

  constructor(private readonly keep = VOICE_SAMPLE_RATE * 60) {}

  append(samples: Float32Array): void {
    this.chunks.push(Float32Array.from(samples))
    this.length += samples.length
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.keep) {
      const dropped = this.chunks.shift()!
      this.first += dropped.length
      this.length -= dropped.length
    }
  }

  /** Index just past the newest sample. */
  end(): number {
    return this.first + this.length
  }

  slice(start: number, end: number): Float32Array {
    const from = Math.max(start, this.first)
    const to = Math.min(end, this.first + this.length)
    const out = new Float32Array(Math.max(0, to - from))
    let position = this.first
    for (const chunk of this.chunks) {
      const chunkEnd = position + chunk.length
      if (chunkEnd > from && position < to) {
        const begin = Math.max(from, position)
        const finish = Math.min(to, chunkEnd)
        out.set(chunk.subarray(begin - position, finish - position), begin - from)
      }
      position = chunkEnd
    }
    return out
  }
}

interface SpeechRun {
  stopped: boolean
}

// Dictation first: it is what a user reaches for, and it is the larger wait.
const DOWNLOAD_ORDER: VoiceModelId[] = ['dictation', 'speech']
const DEFAULT_RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000]

/**
 * Owns the local speech models: downloads them quietly in the background,
 * loads them on first use, and drops them after a while unused. Dictation
 * finds speech with Silero VAD and transcribes each stretch with Parakeet as
 * the user talks, so stopping leaves only the last stretch to decode.
 * Read-aloud streams Supertonic audio sentence by sentence.
 */
export class VoiceService {
  private readonly store: VoiceModelStore
  private readonly loadSherpa: () => Promise<SherpaModule>
  private readonly setTimer: NonNullable<VoiceServiceOptions['setTimer']>
  private readonly clearTimer: NonNullable<VoiceServiceOptions['clearTimer']>
  private readonly retryDelays: number[]
  private readonly idleUnloadMs: number
  private enabled: boolean
  private models: Record<VoiceModelId, VoiceModelState> = {
    dictation: { status: 'missing', receivedBytes: 0, totalBytes: 0 },
    speech: { status: 'missing', receivedBytes: 0, totalBytes: 0 }
  }
  private readonly listeners = new Set<(state: VoiceState) => void>()
  private queue: VoiceModelId[] = []
  private active?: { id: VoiceModelId; controller: AbortController }
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAttempt = 0
  private initialized?: Promise<void>
  private sherpa?: Promise<SherpaModule>
  private recognizer?: Promise<SherpaRecognizer>
  private tts?: Promise<SherpaTts>
  private idleTimer?: ReturnType<typeof setTimeout>
  private readonly dictations = new Map<string, DictationSession>()
  private readonly speeches = new Map<string, SpeechRun>()

  constructor(options: VoiceServiceOptions) {
    this.store = options.store
    this.enabled = options.enabled
    this.loadSherpa =
      options.loadSherpa ??
      (async () => {
        // A CommonJS addon: bundled imports may or may not wrap it in `default`.
        const loaded = (await import('sherpa-onnx-node')) as { default?: unknown }
        return (loaded.default ?? loaded) as SherpaModule
      })
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
    this.idleUnloadMs = options.idleUnloadMs ?? 10 * 60_000
    const startDelay = options.startDelayMs ?? 20_000
    this.initialized = this.initialize().then(() => {
      if (startDelay <= 0) this.pump()
      else this.retryTimer = this.setTimer(() => this.pump(), startDelay)
    })
  }

  private async initialize(): Promise<void> {
    for (const id of DOWNLOAD_ORDER) {
      this.models[id] = await this.store.initialState(VOICE_MODELS[id]).catch(() => ({
        status: 'missing' as const,
        receivedBytes: 0,
        totalBytes: 0
      }))
    }
    this.queue = DOWNLOAD_ORDER.filter((id) => this.models[id].status !== 'ready')
    this.publish()
  }

  ready(): Promise<void> {
    return this.initialized ?? Promise.resolve()
  }

  state(): VoiceState {
    return { enabled: this.enabled, models: structuredClone(this.models) }
  }

  onState(listener: (state: VoiceState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  private setModel(id: VoiceModelId, patch: Partial<VoiceModelState>): void {
    this.models[id] = { ...this.models[id], ...patch }
    this.publish()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.active?.controller.abort()
      if (this.retryTimer) this.clearTimer(this.retryTimer)
      this.retryTimer = undefined
      this.unload()
    }
    this.publish()
    if (enabled) void this.ready().then(() => this.pump())
  }

  /** Moves a model the user just asked for to the front of the download queue. */
  prioritize(id: VoiceModelId): void {
    if (!this.enabled || this.models[id].status === 'ready') return
    this.queue = [id, ...this.queue.filter((item) => item !== id)]
    if (this.active && this.active.id !== id) {
      // Its progress is kept on disk; it resumes after the requested model.
      this.queue.push(this.active.id)
      this.active.controller.abort()
      return
    }
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = undefined
      this.retryAttempt = 0
    }
    this.pump()
  }

  private pump(): void {
    this.retryTimer = undefined
    if (!this.enabled || this.active) return
    const id = this.queue.find((item) => this.models[item].status !== 'ready')
    this.queue = this.queue.filter((item) => this.models[item].status !== 'ready' && item !== id)
    if (!id) return
    const manifest = VOICE_MODELS[id]
    const controller = new AbortController()
    this.active = { id, controller }
    this.setModel(id, { status: 'downloading', error: undefined })
    let lastPublished = 0
    void this.store
      .download(
        manifest,
        (receivedBytes) => {
          this.models[id].receivedBytes = receivedBytes
          const now = Date.now()
          if (now - lastPublished >= 250) {
            lastPublished = now
            this.publish()
          }
        },
        controller.signal
      )
      .then(() => {
        this.retryAttempt = 0
        this.setModel(id, { status: 'ready', receivedBytes: this.models[id].totalBytes })
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) {
          this.setModel(id, { status: 'queued' })
          return
        }
        this.setModel(id, { status: 'error', error: error.message })
        this.queue.push(id)
        const delay = this.retryDelays[Math.min(this.retryAttempt, this.retryDelays.length - 1)]
        this.retryAttempt++
        this.active = undefined
        this.retryTimer = this.setTimer(() => this.pump(), delay)
      })
      .finally(() => {
        if (this.active?.controller === controller) this.active = undefined
        if (this.retryTimer === undefined) this.pump()
      })
  }

  private availability(id: VoiceModelId): VoiceStartResult {
    if (!this.enabled) {
      return {
        ok: false,
        reason: 'disabled',
        message: 'Voice is turned off in Settings → General.'
      }
    }
    const model = this.models[id]
    if (model.status === 'ready') return { ok: true }
    this.prioritize(id)
    const percent = Math.floor(
      (model.totalBytes ? model.receivedBytes / model.totalBytes : 0) * 100
    )
    return {
      ok: false,
      reason: 'downloading',
      message: `${id === 'dictation' ? 'Dictation' : 'Read aloud'} is still being set up (${percent}%). It works on this device once the download finishes.`
    }
  }

  private module(): Promise<SherpaModule> {
    this.sherpa ??= this.loadSherpa().catch((error) => {
      this.sherpa = undefined
      throw error
    })
    return this.sherpa
  }

  private touch(): void {
    if (this.idleTimer) this.clearTimer(this.idleTimer)
    this.idleTimer = this.setTimer(() => {
      if (this.dictations.size || this.speeches.size) this.touch()
      else this.unload()
    }, this.idleUnloadMs)
  }

  /** Drops loaded models; the native memory is released once they are collected. */
  private unload(): void {
    this.recognizer = undefined
    this.tts = undefined
    if (this.idleTimer) this.clearTimer(this.idleTimer)
    this.idleTimer = undefined
  }

  private loadRecognizer(): Promise<SherpaRecognizer> {
    const manifest = VOICE_MODELS.dictation
    this.recognizer ??= this.module()
      .then((sherpa) =>
        sherpa.OfflineRecognizer.createAsync({
          featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: this.store.path(manifest, 'encoder.int8.onnx'),
              decoder: this.store.path(manifest, 'decoder.int8.onnx'),
              joiner: this.store.path(manifest, 'joiner.int8.onnx')
            },
            tokens: this.store.path(manifest, 'tokens.txt'),
            modelType: 'nemo_transducer',
            numThreads: 4,
            provider: 'cpu',
            debug: false
          }
        })
      )
      .catch((error) => {
        this.recognizer = undefined
        throw error
      })
    return this.recognizer
  }

  private loadTts(): Promise<SherpaTts> {
    const manifest = VOICE_MODELS.speech
    const file = (name: string): string => this.store.path(manifest, name)
    this.tts ??= this.module()
      .then((sherpa) =>
        sherpa.OfflineTts.createAsync({
          model: {
            supertonic: {
              durationPredictor: file('duration_predictor.int8.onnx'),
              textEncoder: file('text_encoder.int8.onnx'),
              vectorEstimator: file('vector_estimator.int8.onnx'),
              vocoder: file('vocoder.int8.onnx'),
              ttsJson: file('tts.json'),
              unicodeIndexer: file('unicode_indexer.bin'),
              voiceStyle: file('voice.bin')
            },
            numThreads: 2,
            provider: 'cpu',
            debug: false
          },
          maxNumSentences: 1
        })
      )
      .catch((error) => {
        this.tts = undefined
        throw error
      })
    return this.tts
  }

  /**
   * `onText` receives each phrase's final text, and drafts of the phrase in
   * progress (`final` false) that the next call for that phrase replaces.
   */
  async startDictation(
    sessionId: string,
    onText: (text: string, final: boolean) => void
  ): Promise<VoiceStartResult> {
    await this.ready()
    const availability = this.availability('dictation')
    if (!availability.ok) return availability
    try {
      const sherpa = await this.module()
      // Loading starts now so the first stretch of speech need not wait for it.
      void this.loadRecognizer().catch(() => undefined)
      const vad = new sherpa.Vad(
        {
          sileroVad: {
            model: this.store.path(VOICE_MODELS.dictation, 'silero_vad.onnx'),
            threshold: 0.45,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.2,
            maxSpeechDuration: 25,
            windowSize: 512
          },
          sampleRate: VOICE_SAMPLE_RATE,
          numThreads: 1,
          provider: 'cpu',
          debug: false
        },
        60
      )
      this.dictations.set(sessionId, {
        vad,
        audio: new DictationAudio(),
        transcribedUntil: 0,
        decoding: Promise.resolve(),
        pending: 0,
        draftedAt: 0,
        drafting: false,
        onText
      })
      this.touch()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        message: `Dictation could not start: ${(error as Error).message}`
      }
    }
  }

  pushDictationAudio(sessionId: string, samples: Float32Array): void {
    const session = this.dictations.get(sessionId)
    if (!session || !samples.length) return
    session.audio.append(samples)
    session.vad.acceptWaveform(samples)
    this.drain(session)
    this.draft(session)
  }

  /** Runs decodes one at a time; a failed one does not stop those after it. */
  private enqueue(session: DictationSession, task: () => Promise<void>): void {
    session.pending++
    session.decoding = session.decoding
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        session.pending--
      })
  }

  private async transcribe(samples: Float32Array): Promise<string> {
    const recognizer = await this.loadRecognizer()
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples })
    return (await recognizer.decodeAsync(stream)).text.trim()
  }

  /**
   * While the user is still talking, transcribes the phrase so far so words
   * appear as they are spoken. The draft is replaced when the phrase ends.
   * Skipped while a decode is queued, so drafts never delay the final text.
   */
  private draft(session: DictationSession): void {
    const now = Date.now()
    if (session.pending || !session.vad.isDetected() || now - session.draftedAt < DRAFT_INTERVAL_MS)
      return
    const end = session.audio.end()
    const start = Math.max(session.transcribedUntil, end - DRAFT_WINDOW)
    if (end - start < VOICE_SAMPLE_RATE * 0.3) return
    session.draftedAt = now
    const samples = session.audio.slice(start, end)
    this.enqueue(session, async () => {
      const text = await this.transcribe(samples)
      // A phrase that ended meanwhile has its final text queued after this.
      if (!text) return
      session.drafting = true
      session.onText(text, false)
    })
  }

  private drain(session: DictationSession): void {
    while (!session.vad.isEmpty()) {
      const segment = session.vad.front(false)
      // The detector starts a stretch after its first sound, which clipped a
      // short opening word. Transcribe it with some of the audio around it,
      // but never reach back into the stretch before, or words would repeat.
      const end = segment.start + segment.samples.length
      const samples = session.audio.slice(
        Math.max(segment.start - SEGMENT_LEAD_IN, session.transcribedUntil),
        end + SEGMENT_TAIL
      )
      session.transcribedUntil = end
      session.vad.pop()
      this.enqueue(session, async () => {
        const text = await this.transcribe(samples)
        // Even an empty result replaces a draft shown for this phrase.
        if (!text && !session.drafting) return
        session.drafting = false
        session.onText(text, true)
      })
    }
  }

  /** Transcribes whatever speech is still pending, then ends the session. */
  async stopDictation(sessionId: string): Promise<void> {
    const session = this.dictations.get(sessionId)
    if (!session) return
    session.vad.flush()
    this.drain(session)
    try {
      await session.decoding
    } finally {
      this.dictations.delete(sessionId)
      this.touch()
    }
  }

  cancelDictation(sessionId: string): void {
    const session = this.dictations.get(sessionId)
    if (!session) return
    session.onText = () => undefined
    this.dictations.delete(sessionId)
  }

  async speak(
    speechId: string,
    markdown: string,
    onAudio: (samples: Float32Array, sampleRate: number) => void,
    options: SpeechOptions = {}
  ): Promise<VoiceStartResult & { finished?: Promise<void> }> {
    await this.ready()
    const availability = this.availability('speech')
    if (!availability.ok) return availability
    const text = speakableText(markdown)
    if (!text) {
      return {
        ok: false,
        reason: 'unavailable',
        message: 'This message has nothing to read aloud.'
      }
    }
    const voice =
      Number.isInteger(options.voice) &&
      options.voice! >= 0 &&
      options.voice! < SPEECH_VOICES.length
        ? options.voice!
        : DEFAULT_SPEECH_VOICE
    const language = isSpeechLanguage(options.language)
      ? options.language
      : detectSpeechLanguage(text)
    const run: SpeechRun = { stopped: false }
    this.speeches.set(speechId, run)
    this.touch()
    try {
      const sherpa = await this.module()
      const tts = await this.loadTts()
      const generationConfig = new sherpa.GenerationConfig({
        sid: voice,
        speed: 1.1,
        numSteps: 8,
        extra: { lang: language }
      })
      const finished = tts
        .generateAsync({
          text,
          generationConfig,
          enableExternalBuffer: false,
          onProgress: ({ samples }) => {
            if (run.stopped) return 0
            onAudio(Float32Array.from(samples), tts.sampleRate)
            return 1
          }
        })
        .then(() => undefined)
        .finally(() => {
          this.speeches.delete(speechId)
          this.touch()
        })
      return { ok: true, finished }
    } catch (error) {
      this.speeches.delete(speechId)
      return {
        ok: false,
        reason: 'unavailable',
        message: `Read aloud could not start: ${(error as Error).message}`
      }
    }
  }

  stopSpeech(speechId: string): void {
    const run = this.speeches.get(speechId)
    if (run) run.stopped = true
  }

  dispose(): void {
    this.active?.controller.abort()
    if (this.retryTimer) this.clearTimer(this.retryTimer)
    for (const run of this.speeches.values()) run.stopped = true
    this.dictations.clear()
    this.listeners.clear()
    this.unload()
  }
}
