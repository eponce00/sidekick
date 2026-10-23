import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  DICTATION_SAMPLE_RATE,
  downmix,
  float32ToBytes,
  pcm16ToFloat32,
  resample
} from './audio'

/** The computer's encoding of speech, as `pcm16Base64` in the main process writes it. */
function computerPcm16(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true)
  })
  return bytes
}

describe('base64', () => {
  it('round-trips bytes, including ones past the argument limit of a single call', () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256)
    const text = bytesToBase64(bytes)
    expect(text).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
    expect(base64ToBytes(text)).toEqual(bytes)
  })

  it('matches the standard alphabet the computer decodes', () => {
    expect(bytesToBase64(new Uint8Array([251, 255]))).toBe('+/8=')
  })
})

describe('speech samples', () => {
  it('decode the computer’s 16-bit samples back to floats', () => {
    const samples = pcm16ToFloat32(computerPcm16([0, 1, -1, 0.5, -0.25]))
    expect(Array.from(samples)).toEqual([0, 1, -1, expect.closeTo(0.5, 4), -0.25])
  })

  it('ignore a trailing odd byte', () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 64, 7]))).toHaveLength(1)
  })

  it('decode a piece that starts inside a larger buffer', () => {
    const whole = new Uint8Array([9, 9, ...computerPcm16([1])])
    expect(Array.from(pcm16ToFloat32(whole.subarray(2)))).toEqual([1])
  })
})

describe('dictation samples', () => {
  it('are little-endian floats whatever the phone’s byte order', () => {
    const bytes = float32ToBytes(new Float32Array([1, -0.5]))
    expect(Array.from(bytes)).toEqual([0, 0, 128, 63, 0, 0, 0, 191])
    const view = new DataView(bytes.buffer)
    expect(view.getFloat32(4, true)).toBe(-0.5)
  })

  it('mix several channels into one', () => {
    const left = new Float32Array([1, 0.5, 0])
    const right = new Float32Array([0, 0.5, 1, 1])
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, 0.5])
    expect(downmix([left])).toBe(left)
  })

  it('come down to 16 kHz by averaging what each sample covers', () => {
    const rate = 48_000
    const input = Float32Array.from({ length: rate }, (_, index) => (index % 3 === 0 ? 3 : 0))
    const output = resample(input, rate, DICTATION_SAMPLE_RATE)
    expect(output).toHaveLength(DICTATION_SAMPLE_RATE)
    // Each output sample covers three input samples, one of which is 3.
    expect(output.every((sample) => Math.abs(sample - 1) < 1e-6)).toBe(true)
  })

  it('keep their length in time from rates that do not divide evenly', () => {
    const input = new Float32Array(44_100).fill(0.25)
    const output = resample(input, 44_100, DICTATION_SAMPLE_RATE)
    expect(output).toHaveLength(16_000)
    expect(output.every((sample) => Math.abs(sample - 0.25) < 1e-6)).toBe(true)
  })

  it('go up from a lower rate between neighbouring samples', () => {
    const output = resample(new Float32Array([0, 1, 0, 1]), 8_000, 16_000)
    expect(Array.from(output)).toEqual([0, 0.5, 1, 0.5, 0, 0.5, 1, 1])
  })

  it('are left alone at 16 kHz already', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(resample(input, DICTATION_SAMPLE_RATE, DICTATION_SAMPLE_RATE)).toBe(input)
  })
})
