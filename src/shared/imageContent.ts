import type { ToolResultImageMimeType } from './agentRuntime'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((byte, index) => bytes[at + index] === byte)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/**
 * The image type its bytes declare, or nothing when they are not a whole image. A provider rejects
 * a request carrying an undecodable image and the run ends there, so a file named .png that a shell
 * redirect re-encoded, or a capture cut short, must never reach one.
 */
export function imageContentType(bytes: Uint8Array): ToolResultImageMimeType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    for (let at = bytes.length - PNG_END.length; at >= Math.max(8, bytes.length - 64); at--) {
      if (startsWith(bytes, PNG_END, at)) return 'image/png'
    }
    return undefined
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  const head = ascii(bytes, 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}
