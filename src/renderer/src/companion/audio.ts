/**
 * Sound between the phone and the computer, both ways as 16-bit little-endian samples: the
 * microphone goes up as the computer's dictation reads it, and speech comes down, half the size of
 * floats.
 */

/** Standard base64, as the computer's uploads and speech use. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // In pieces: one call with a whole file overflows the argument limit.
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

/** Floats from -1 to 1 as 16-bit little-endian samples, whatever order this phone keeps them in. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
  }
  return bytes
}
