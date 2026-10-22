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

/** Image formats SideKick can read. Providers take only some; the rest are converted first. */
export type ReadableImageMimeType = ToolResultImageMimeType | 'image/avif' | 'image/bmp'

export interface ImageHeader {
  mimeType: ReadableImageMimeType
  /** Pixel size as the image is shown, after any EXIF rotation. */
  width: number
  height: number
  /** EXIF orientation 2–8 when a JPEG asks to be rotated or mirrored; absent when upright. */
  orientation?: number
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function exifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
  // An APP1 segment: "Exif\0\0", then a TIFF header and IFD0, whose 0x0112 entry is the rotation.
  if (end - start < 14 || ascii(bytes, start, start + 6) !== 'Exif\0\0') return undefined
  const tiff = start + 6
  const order = ascii(bytes, tiff, tiff + 2)
  if (order !== 'II' && order !== 'MM') return undefined
  const little = order === 'II'
  const data = view(bytes)
  const ifd = tiff + data.getUint32(tiff + 4, little)
  if (ifd + 2 > end) return undefined
  const entries = data.getUint16(ifd, little)
  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) return undefined
    if (data.getUint16(entry, little) === 0x0112) {
      const value = data.getUint16(entry + 8, little)
      return value >= 2 && value <= 8 ? value : undefined
    }
  }
  return undefined
}

function jpegHeader(bytes: Uint8Array): ImageHeader | undefined {
  const data = view(bytes)
  let orientation: number | undefined
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1]
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Markers without a length: TEM, and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const length = data.getUint16(at + 2)
    if (length < 2) return undefined
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (at + 9 > bytes.length) return undefined
      const height = data.getUint16(at + 5)
      const width = data.getUint16(at + 7)
      if (!width || !height) return undefined
      // Orientations 5–8 turn the image a quarter, so it is shown with its sides swapped.
      const swapped = orientation !== undefined && orientation >= 5
      return {
        mimeType: 'image/jpeg',
        width: swapped ? height : width,
        height: swapped ? width : height,
        ...(orientation ? { orientation } : {})
      }
    }
    if (marker === 0xe1 && orientation === undefined) {
      orientation = exifOrientation(bytes, at + 4, Math.min(bytes.length, at + 2 + length))
    }
    if (marker === 0xda || marker === 0xd9) return undefined
    at += 2 + length
  }
  return undefined
}

function webpHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.length < 30) return undefined
  const data = view(bytes)
  const chunk = ascii(bytes, 12, 16)
  if (chunk === 'VP8 ' && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return {
      mimeType: 'image/webp',
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = data.getUint32(21, true)
    return {
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1
    }
  }
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return { mimeType: 'image/webp', width, height }
  }
  return undefined
}

function isoBrand(bytes: Uint8Array): string | undefined {
  return bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' ? ascii(bytes, 8, 12) : undefined
}

function avifHeader(bytes: Uint8Array): ImageHeader | undefined {
  // The image's spatial extent ("ispe") box; an image with alpha or a thumbnail has several.
  const data = view(bytes)
  let width = 0
  let height = 0
  const limit = Math.min(bytes.length - 16, 1 << 20)
  for (let at = 4; at <= limit; at++) {
    if (bytes[at] !== 0x69 || ascii(bytes, at, at + 4) !== 'ispe') continue
    const boxWidth = data.getUint32(at + 8)
    const boxHeight = data.getUint32(at + 12)
    if (boxWidth * boxHeight > width * height) {
      width = boxWidth
      height = boxHeight
    }
  }
  return width && height ? { mimeType: 'image/avif', width, height } : undefined
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

/** True for an Apple HEIC/HEIF photo, which SideKick cannot decode yet. */
export function isHeifImage(bytes: Uint8Array): boolean {
  const brand = isoBrand(bytes)
  return brand !== undefined && HEIF_BRANDS.has(brand)
}

/** The readable format the leading bytes announce, before anything about them is trusted. */
export function imageSignature(bytes: Uint8Array): ReadableImageMimeType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  const head = ascii(bytes, 0, 6)
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (head.startsWith('BM')) return 'image/bmp'
  const brand = isoBrand(bytes)
  if (brand === 'avif' || brand === 'avis') return 'image/avif'
  return undefined
}

/**
 * The format and size an image's header declares, read without decoding it. Decoding allocates
 * four bytes per pixel, so a few kilobytes that declare a 60 000-pixel square must be caught here.
 * Undefined when the bytes are not an image SideKick can read.
 */
export function imageHeader(bytes: Uint8Array): ImageHeader | undefined {
  try {
    const data = view(bytes)
    switch (imageSignature(bytes)) {
      case 'image/png':
        if (ascii(bytes, 12, 16) !== 'IHDR') return undefined
        return { mimeType: 'image/png', width: data.getUint32(16), height: data.getUint32(20) }
      case 'image/jpeg':
        return jpegHeader(bytes)
      case 'image/gif':
        return {
          mimeType: 'image/gif',
          width: data.getUint16(6, true),
          height: data.getUint16(8, true)
        }
      case 'image/webp':
        return webpHeader(bytes)
      case 'image/bmp':
        // Height is negative for a top-down bitmap.
        return {
          mimeType: 'image/bmp',
          width: Math.abs(data.getInt32(18, true)),
          height: Math.abs(data.getInt32(22, true))
        }
      case 'image/avif':
        return avifHeader(bytes)
    }
  } catch {
    // A header cut short reads past the end; it is not a readable image.
  }
  return undefined
}

/** The first `limit` bytes of a base64 data URL, decoded: enough to read its header. */
export function dataUrlHead(dataUrl: string, limit: number): Uint8Array | undefined {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return undefined
  try {
    const binary = atob(dataUrl.slice(comma + 1, comma + 1 + Math.ceil(limit / 3) * 4))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}
