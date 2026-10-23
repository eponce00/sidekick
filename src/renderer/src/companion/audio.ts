/**
 * Sound between the phone and the computer: recordings go up as the 16 kHz mono floats the
 * computer's dictation reads, and speech comes down as 16-bit samples, half the size of floats.
 */

/** The rate the computer's dictation model reads. */
export const DICTATION_SAMPLE_RATE = 16_000

/** Standard base64, as the computer's uploads and speech use. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // In pieces: one call with a whole recording overflows the argument limit.
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** 16-bit little-endian samples as floats from -1 to 1; the reverse of the computer's encoding. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2))
  for (let index = 0; index < samples.length; index++) {
    const value = view.getInt16(index * 2, true)
    samples[index] = value < 0 ? value / 0x8000 : value / 0x7fff
  }
  return samples
}

/** Floats as little-endian bytes, whatever order this phone keeps them in. */
export function float32ToBytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index++)
    view.setFloat32(index * 4, samples[index], true)
  return bytes
}

/** One channel from several: their average. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map((channel) => channel.length))
  const out = new Float32Array(length)
  for (const channel of channels)
    for (let index = 0; index < length; index++) out[index] += channel[index] / channels.length
  return out
}

/**
 * Changes the sample rate by averaging the input under each output sample, which also keeps
 * sound above the new rate's limit from folding back into speech. Used where the browser cannot
 * render the audio again itself.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let index = 0; index < out.length; index++) {
    const start = index * ratio
    const end = Math.min(samples.length, start + ratio)
    if (ratio <= 1) {
      // Upsampling: between the two nearest input samples.
      const at = Math.floor(start)
      const next = Math.min(samples.length - 1, at + 1)
      out[index] = samples[at] + (samples[next] - samples[at]) * (start - at)
      continue
    }
    let sum = 0
    let count = 0
    for (let position = Math.floor(start); position < end; position++) {
      sum += samples[position]
      count++
    }
    out[index] = count ? sum / count : 0
  }
  return out
}

type AudioContextClass = typeof AudioContext
type OfflineContextClass = typeof OfflineAudioContext

function audioContextClass(): AudioContextClass | undefined {
  const scope = globalThis as { AudioContext?: AudioContextClass; webkitAudioContext?: unknown }
  return scope.AudioContext ?? (scope.webkitAudioContext as AudioContextClass | undefined)
}

function offlineContextClass(): OfflineContextClass | undefined {
  const scope = globalThis as {
    OfflineAudioContext?: OfflineContextClass
    webkitOfflineAudioContext?: unknown
  }
  return (
    scope.OfflineAudioContext ??
    (scope.webkitOfflineAudioContext as OfflineContextClass | undefined)
  )
}

/** A recording the phone made, as the samples dictation reads. */
export async function recordingToDictationSamples(file: Blob): Promise<Float32Array> {
  const Context = audioContextClass()
  if (!Context) throw new Error('This phone cannot read recordings.')
  const context = new Context()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer())
  } finally {
    void context.close().catch(() => undefined)
  }
  const Offline = offlineContextClass()
  if (Offline && decoded.duration > 0) {
    try {
      // Rendering again lets the browser filter and mix down as it plays sound.
      const length = Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE)
      const offline = new Offline(1, length, DICTATION_SAMPLE_RATE)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return rendered.getChannelData(0).slice()
    } catch {
      /* Some browsers refuse this rate; the samples are converted here instead. */
    }
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
    decoded.getChannelData(index)
  )
  return resample(downmix(channels), decoded.sampleRate, DICTATION_SAMPLE_RATE)
}
