import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, float32ToPcm16, pcm16ToFloat32 } from './audio'

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

describe('microphone samples', () => {
  it('encode as the computer reads them, little-endian whatever the phone’s byte order', () => {
    const bytes = float32ToPcm16(new Float32Array([0, 1, -1, 0.5, 2]))
    const view = new DataView(bytes.buffer)
    expect([0, 1, 2, 3, 4].map((index) => view.getInt16(index * 2, true))).toEqual([
      0, 32767, -32768, 16384, 32767
    ])
    expect(Array.from(bytes.subarray(2, 4))).toEqual([0xff, 0x7f])
  })

  it('come back to the same floats', () => {
    const samples = pcm16ToFloat32(float32ToPcm16(new Float32Array([0.25, -0.75])))
    expect(Array.from(samples)).toEqual([expect.closeTo(0.25, 4), -0.75])
  })
})
