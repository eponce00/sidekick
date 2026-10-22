import { describe, expect, it } from 'vitest'
import { imageContentType, imageHeader, imageSignature, isHeifImage } from './imageContent'

function bytes(...parts: Array<number[] | string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string'
      ? Uint8Array.from(part, (character) => character.charCodeAt(0))
      : Uint8Array.from(part)
  )
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    result.set(chunk, at)
    at += chunk.length
  }
  return result
}

const be16 = (value: number): number[] => [value >> 8, value & 0xff]
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff
]
const le16 = (value: number): number[] => [value & 0xff, value >> 8]
const le32 = (value: number): number[] => be32(value).reverse()

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    'IHDR',
    be32(width),
    be32(height),
    [8, 2, 0, 0, 0],
    be32(0)
  )
}

function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const exif = orientation
    ? bytes(
        'Exif\0\0',
        'MM',
        be16(42),
        be32(8),
        be16(1),
        be16(0x0112),
        be16(3),
        be32(1),
        be16(orientation),
        [0, 0],
        be32(0)
      )
    : undefined
  return bytes(
    [0xff, 0xd8],
    exif ? bytes([0xff, 0xe1], be16(exif.length + 2), exif) : [],
    [0xff, 0xdb],
    be16(4),
    [0, 0],
    [0xff, 0xc0],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  )
}

describe('image headers', () => {
  it('reads the size every supported format declares', () => {
    expect(imageHeader(png(2560, 1440))).toEqual({
      mimeType: 'image/png',
      width: 2560,
      height: 1440
    })
    expect(imageHeader(jpeg(4032, 3024))).toEqual({
      mimeType: 'image/jpeg',
      width: 4032,
      height: 3024
    })
    expect(imageHeader(bytes('GIF89a', le16(320), le16(200), [0]))).toEqual({
      mimeType: 'image/gif',
      width: 320,
      height: 200
    })
    const vp8 = bytes(
      'RIFF',
      le32(30),
      'WEBP',
      'VP8 ',
      le32(18),
      [0, 0, 0],
      [0x9d, 0x01, 0x2a],
      le16(1920),
      le16(1080),
      [0, 0]
    )
    expect(imageHeader(vp8)).toMatchObject({ mimeType: 'image/webp', width: 1920, height: 1080 })
    const lossless = bytes(
      'RIFF',
      le32(30),
      'WEBP',
      'VP8L',
      le32(10),
      [0x2f],
      le32((800 - 1) | ((600 - 1) << 14)),
      [0, 0, 0, 0, 0]
    )
    expect(imageHeader(lossless)).toMatchObject({ width: 800, height: 600 })
    const extended = bytes(
      'RIFF',
      le32(30),
      'WEBP',
      'VP8X',
      le32(10),
      [0, 0, 0, 0],
      [0xff, 0x13, 0x00],
      [0x37, 0x0b, 0x00]
    )
    expect(imageHeader(extended)).toMatchObject({ width: 5120, height: 2872 })
    const bmp = bytes('BM', new Uint8Array(16), le32(640), le32(-480 >>> 0), new Uint8Array(4))
    expect(imageHeader(bmp)).toEqual({ mimeType: 'image/bmp', width: 640, height: 480 })
    const avif = bytes(
      be32(20),
      'ftyp',
      'avif',
      be32(0),
      'mif1',
      be32(20),
      'ispe',
      be32(0),
      be32(3840),
      be32(2160)
    )
    expect(imageHeader(avif)).toEqual({ mimeType: 'image/avif', width: 3840, height: 2160 })
  })

  it('swaps a JPEG’s sides when EXIF turns it a quarter, as decoders show it', () => {
    expect(imageHeader(jpeg(4032, 3024, 6))).toEqual({
      mimeType: 'image/jpeg',
      width: 3024,
      height: 4032,
      orientation: 6
    })
    expect(imageHeader(jpeg(4032, 3024, 3))).toMatchObject({ width: 4032, orientation: 3 })
    expect(imageHeader(jpeg(4032, 3024, 1))).toEqual({
      mimeType: 'image/jpeg',
      width: 4032,
      height: 3024
    })
  })

  it('reads a decompression bomb’s declared size without decoding it', () => {
    expect(imageHeader(png(60_000, 60_000))).toMatchObject({ width: 60_000, height: 60_000 })
  })

  it('reads nothing from bytes that are not an image or stop inside the header', () => {
    expect(imageHeader(bytes('not an image at all'))).toBeUndefined()
    expect(imageHeader(png(10, 10).subarray(0, 18))).toBeUndefined()
    expect(imageHeader(jpeg(10, 10).subarray(0, 12))).toBeUndefined()
    expect(imageSignature(bytes('not an image'))).toBeUndefined()
  })

  it('recognizes HEIC photos so they can be refused by name', () => {
    const heic = bytes(be32(24), 'ftyp', 'heic', be32(0), 'mif1', 'heic')
    expect(isHeifImage(heic)).toBe(true)
    expect(imageSignature(heic)).toBeUndefined()
    expect(isHeifImage(png(1, 1))).toBe(false)
  })

  it('still requires a whole PNG before calling it one', () => {
    expect(imageSignature(png(1, 1))).toBe('image/png')
    expect(imageContentType(png(1, 1))).toBeUndefined()
  })
})
