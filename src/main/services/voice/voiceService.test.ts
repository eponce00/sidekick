import { describe, expect, it, vi } from 'vitest'
import type { VoiceModelId, VoiceModelState } from '../../../shared/voice'
import type { VoiceModelManifest, VoiceModelStore } from './voiceModels'
import { DictationAudio, VoiceService, type SherpaModule } from './voiceService'

function fakeStore(ready: VoiceModelId[] = []) {
  const downloads: Array<{
    id: VoiceModelId
    resolve: () => void
    reject: (error: Error) => void
    signal: AbortSignal
  }> = []
  const store = {
    path: (manifest: VoiceModelManifest, name: string) => `/models/${manifest.folder}/${name}`,
    initialState: vi.fn(
      async (manifest: VoiceModelManifest): Promise<VoiceModelState> => ({
        status: ready.includes(manifest.id) ? 'ready' : 'missing',
        receivedBytes: 0,
        totalBytes: 100
      })
    ),
    download: vi.fn(
      (manifest: VoiceModelManifest, _progress: (bytes: number) => void, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          downloads.push({ id: manifest.id, resolve, reject, signal })
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    ),
    removeFolder: vi.fn(async () => undefined)
  }
  return { store: store as unknown as VoiceModelStore & typeof store, downloads }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function fakeSherpa() {
  // Each pushed frame counts as one detected stretch of speech.
  const vadSegments: Array<{ samples: Float32Array; start: number }> = []
  let received = 0
  const sherpa = {
    Vad: vi.fn(function () {
      return {
        acceptWaveform: (samples: Float32Array) => {
          vadSegments.push({ samples, start: received })
          received += samples.length
        },
        isEmpty: () => vadSegments.length === 0,
        isDetected: () => false,
        front: () => vadSegments[0],
        pop: () => vadSegments.shift(),
        flush: vi.fn()
      }
    }),
    OfflineRecognizer: {
      createAsync: vi.fn(async () => ({
        createStream: () => {
          let length = 0
          return {
            acceptWaveform: ({ samples }: { samples: Float32Array }) => (length = samples.length),
            get length() {
              return length
            }
          }
        },
        decodeAsync: async (stream: { length: number }) => ({ text: `heard ${stream.length}` })
      }))
    },
    OfflineTts: { createAsync: vi.fn() },
    GenerationConfig: vi.fn()
  }
  return sherpa as unknown as SherpaModule & typeof sherpa
}

describe('DictationAudio', () => {
  it('reads back a range across frames and forgets audio older than it keeps', () => {
    const audio = new DictationAudio(6)
    audio.append(Float32Array.of(0, 1, 2))
    audio.append(Float32Array.of(3, 4, 5))
    expect([...audio.slice(1, 5)]).toEqual([1, 2, 3, 4])
    audio.append(Float32Array.of(6, 7, 8))
    // The first frame is gone; a range reaching into it is cut to what is kept.
    expect([...audio.slice(0, 20)]).toEqual([3, 4, 5, 6, 7, 8])
  })
})

describe('VoiceService', () => {
  it('downloads missing models in the background, dictation first', async () => {
    const { store, downloads } = fakeStore()
    const service = new VoiceService({ store, enabled: true, startDelayMs: 0 })
    await service.ready()
    expect(downloads.map((item) => item.id)).toEqual(['dictation'])
    downloads[0].resolve()
    await flush()
    expect(service.state().models.dictation.status).toBe('ready')
    expect(downloads.map((item) => item.id)).toEqual(['dictation', 'speech'])
  })

  it('does not download while voice is turned off', async () => {
    const { store, downloads } = fakeStore()
    const service = new VoiceService({ store, enabled: false, startDelayMs: 0 })
    await service.ready()
    expect(downloads).toHaveLength(0)
    service.setEnabled(true)
    await flush()
    expect(downloads).toHaveLength(1)
  })

  it('moves the model a user reaches for to the front, keeping the other for later', async () => {
    const { store, downloads } = fakeStore()
    const service = new VoiceService({ store, enabled: true, startDelayMs: 0 })
    await service.ready()
    const result = await service.speak('speech-1', 'Hello there.', () => undefined)
    expect(result).toMatchObject({ ok: false, reason: 'downloading' })
    await flush()
    expect(downloads[0].signal.aborted).toBe(true)
    expect(downloads.at(-1)?.id).toBe('speech')
    downloads.at(-1)!.resolve()
    await flush()
    expect(downloads.at(-1)?.id).toBe('dictation')
  })

  it('retries a failed download later instead of immediately', async () => {
    const { store, downloads } = fakeStore(['speech'])
    const timers: Array<{ callback: () => void; ms: number }> = []
    const service = new VoiceService({
      store,
      enabled: true,
      startDelayMs: 0,
      setTimer: (callback, ms) => {
        timers.push({ callback, ms })
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
      retryDelaysMs: [1_000]
    })
    await service.ready()
    downloads[0].reject(new Error('offline'))
    await flush()
    expect(service.state().models.dictation).toMatchObject({ status: 'error', error: 'offline' })
    expect(downloads).toHaveLength(1)
    timers.find((timer) => timer.ms === 1_000)!.callback()
    expect(downloads).toHaveLength(2)
  })

  it('transcribes each stretch of speech as it arrives and the rest on stop', async () => {
    const { store } = fakeStore(['dictation', 'speech'])
    const sherpa = fakeSherpa()
    const service = new VoiceService({
      store,
      enabled: true,
      startDelayMs: 0,
      loadSherpa: async () => sherpa
    })
    const heard: string[] = []
    expect(await service.startDictation('session-1', (text) => heard.push(text))).toEqual({
      ok: true
    })
    service.pushDictationAudio('session-1', new Float32Array(16_000))
    service.pushDictationAudio('session-1', new Float32Array(8_000))
    await service.stopDictation('session-1')
    // A stretch is read with up to 0.6 s before it and 0.3 s after, as far as
    // audio exists, and never from before where the previous stretch ended.
    expect(heard).toEqual(['heard 16000', 'heard 8000'])
    expect(sherpa.OfflineRecognizer.createAsync).toHaveBeenCalledTimes(1)
  })

  it('says why dictation cannot start while voice is off', async () => {
    const { store } = fakeStore(['dictation'])
    const service = new VoiceService({ store, enabled: false, startDelayMs: 0 })
    expect(await service.startDictation('session-1', () => undefined)).toMatchObject({
      ok: false,
      reason: 'disabled'
    })
  })

  it('says a reply a passage at a time, with a pause between passages', async () => {
    const { store } = fakeStore(['dictation', 'speech'])
    const sherpa = fakeSherpa()
    const said: string[] = []
    sherpa.OfflineTts.createAsync.mockResolvedValue({
      sampleRate: 10,
      generateAsync: vi.fn(
        async (request: {
          text: string
          onProgress: (info: { samples: Float32Array }) => void
        }) => {
          said.push(request.text)
          request.onProgress({ samples: Float32Array.of(1, 1) })
          return { samples: Float32Array.of(1, 1), sampleRate: 10 }
        }
      )
    })
    const service = new VoiceService({
      store,
      enabled: true,
      startDelayMs: 0,
      loadSherpa: async () => sherpa
    })
    await service.ready()
    const audio: number[] = []
    const result = await service.speak(
      'speech-1',
      'First point. Second point.\n\nNext paragraph.\n\n## Sources\n- [Reuters](https://reuters.com/x)',
      (samples) => audio.push(samples.length)
    )
    await (result as { finished: Promise<void> }).finished

    expect(said).toEqual(['First point. Second point.', 'Next paragraph.'])
    // Speech, a paragraph's pause (0.55 s at 10 Hz), speech; nothing after the last passage.
    expect(audio).toEqual([2, 6, 2])
    expect(sherpa.OfflineTts.createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          kokoro: expect.objectContaining({ lang: 'en-us' })
        })
      })
    )
  })

  it("reads another language with that language's voice of the same kind", async () => {
    const { store } = fakeStore(['dictation', 'speech'])
    const sherpa = fakeSherpa()
    sherpa.OfflineTts.createAsync.mockResolvedValue({
      sampleRate: 10,
      generateAsync: vi.fn(async () => ({ samples: Float32Array.of(1), sampleRate: 10 }))
    })
    const service = new VoiceService({
      store,
      enabled: true,
      startDelayMs: 0,
      loadSherpa: async () => sherpa
    })
    await service.ready()
    const result = await service.speak(
      'speech-1',
      'El archivo está listo y las pruebas pasan con este cambio para ti.',
      () => undefined,
      { voice: 'am_michael' }
    )
    await (result as { finished: Promise<void> }).finished
    // em_alex, Kokoro's Spanish male voice, through espeak-ng's Spanish.
    expect(sherpa.GenerationConfig).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 29, extra: { lang: 'es' } })
    )
  })

  it('says which languages it reads instead of reading one it cannot', async () => {
    const { store } = fakeStore(['dictation', 'speech'])
    const service = new VoiceService({ store, enabled: true, startDelayMs: 0 })
    await service.ready()
    const result = await service.speak(
      'speech-1',
      'Der Build ist fertig und die Tests sind grün, aber nicht alle.',
      () => undefined
    )
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect((result as { message: string }).message).toMatch(/does not speak German yet/)
  })

  it('removes the voice an earlier SideKick read with', async () => {
    const { store } = fakeStore(['dictation', 'speech'])
    const service = new VoiceService({ store, enabled: true, startDelayMs: 0 })
    await service.ready()
    expect(store.removeFolder).toHaveBeenCalledWith('supertonic-3-int8-2026-05-11')
  })
})
