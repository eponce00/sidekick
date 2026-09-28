import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { VOICE_SAMPLE_RATE } from '../../../shared/voice'
import { VoiceModelStore } from './voiceModels'
import { VoiceService, type SherpaModule } from './voiceService'

// Downloads the real models (about 820 MB) and runs them on this machine:
// Supertonic reads a sentence aloud and Parakeet must transcribe it back.
//   SIDEKICK_VOICE_LIVE=1 [SIDEKICK_VOICE_MODELS_DIR=...] npm test -- voiceService.live
const enabled = process.env.SIDEKICK_VOICE_LIVE === '1'
const root = process.env.SIDEKICK_VOICE_MODELS_DIR || join(tmpdir(), 'sidekick-voice-live')

/** A filtered resample, as Chromium does for the microphone in the app. */
async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  const sherpa = (await import('sherpa-onnx-node')).default as unknown as {
    LinearResampler: new (
      from: number,
      to: number
    ) => { flush(samples: Float32Array): Float32Array }
  }
  return new sherpa.LinearResampler(from, to).flush(samples)
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z]+/g) ?? []

describe.skipIf(!enabled)('local voice models', () => {
  it(
    'reads English and Spanish aloud and transcribes the audio back',
    async () => {
      const service = new VoiceService({
        store: new VoiceModelStore(root),
        enabled: true,
        startDelayMs: 0,
        loadSherpa: async () => (await import('sherpa-onnx-node')).default as SherpaModule
      })
      await service.ready()
      await new Promise<void>((resolve, reject) => {
        const check = (): boolean => {
          const { dictation, speech } = service.state().models
          if (dictation.status === 'ready' && speech.status === 'ready') resolve()
          else if (dictation.status === 'error' || speech.status === 'error') {
            reject(new Error(dictation.error || speech.error))
          } else return false
          return true
        }
        if (!check()) service.onState(() => void check())
      })

      const sentences = [
        'The build passed and every test is green.',
        'El archivo está listo y las pruebas pasan correctamente.'
      ]
      for (const [index, sentence] of sentences.entries()) {
        const chunks: Float32Array[] = []
        let rate = 0
        const started = Date.now()
        const speaking = await service.speak(`speech-${index}`, sentence, (samples, sampleRate) => {
          chunks.push(samples)
          rate = sampleRate
        })
        expect(speaking.ok).toBe(true)
        await (speaking as { finished: Promise<void> }).finished
        const audio = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          audio.set(chunk, offset)
          offset += chunk.length
        }
        const spokenSeconds = audio.length / rate
        const synthesisSeconds = (Date.now() - started) / 1000

        const heard: string[] = []
        let drafts = 0
        const transcribing = Date.now()
        expect(
          await service.startDictation(`dictation-${index}`, (text, final) =>
            final ? heard.push(text) : drafts++
          )
        ).toEqual({ ok: true })
        const speech = await resample(audio, rate, VOICE_SAMPLE_RATE)
        const silence = new Float32Array(VOICE_SAMPLE_RATE)
        for (const part of [silence, speech, silence]) {
          for (let start = 0; start < part.length; start += 1600) {
            service.pushDictationAudio(`dictation-${index}`, part.subarray(start, start + 1600))
          }
        }
        await service.stopDictation(`dictation-${index}`)
        const transcript = heard.join(' ')
        console.log(
          `[voice] "${sentence}" → ${spokenSeconds.toFixed(1)} s of audio in ${synthesisSeconds.toFixed(1)} s → "${transcript}" in ${((Date.now() - transcribing) / 1000).toFixed(1)} s, ${drafts} drafts`
        )
        const expected = words(sentence)
        const got = new Set(words(transcript))
        const matched = expected.filter((word) => got.has(word)).length
        expect(matched / expected.length).toBeGreaterThanOrEqual(0.8)
      }
      service.dispose()
    },
    30 * 60_000
  )
})
