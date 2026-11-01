// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileToMessageImage } from './messageImageAttachments'

// A whole 1x1 PNG.
const PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  ),
  (character) => character.charCodeAt(0)
)

function declaring(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = PIXEL_PNG.slice()
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('attaching images', () => {
  const decode = vi.fn(async () => ({ close: () => undefined }))

  beforeEach(() => {
    decode.mockClear()
    vi.stubGlobal('createImageBitmap', decode)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('attaches an image well over the old 8 MB limit, as its original bytes', async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024)
    bytes.set(declaring(5120, 2880))
    const image = await fileToMessageImage(new File([bytes], 'screen.png', { type: 'image/png' }))
    expect(image).toMatchObject({ name: 'screen.png', mimeType: 'image/png' })
    expect(image.dataUrl.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true)
    expect(Math.floor(((image.dataUrl.length - 22) * 3) / 4)).toBeGreaterThanOrEqual(bytes.length)
  })

  it('names the format from the bytes, not the file’s claimed type', async () => {
    const image = await fileToMessageImage(new File([PIXEL_PNG], 'photo.jpg', { type: '' }))
    expect(image.mimeType).toBe('image/png')
    expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses only absurd inputs, saying why', async () => {
    const huge = new File([PIXEL_PNG], 'huge.png', { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 })
    await expect(fileToMessageImage(huge)).rejects.toThrow('huge.png')

    await expect(
      fileToMessageImage(new File([declaring(60_000, 60_000)], 'bomb.png', { type: 'image/png' }))
    ).rejects.toThrow('bomb.png')
    expect(decode).not.toHaveBeenCalled()
  })

  it('explains HEIC photos and other files it cannot read', async () => {
    const heic = new Uint8Array([
      0,
      0,
      0,
      24,
      ...new TextEncoder().encode('ftypheic\0\0\0\0mif1heic')
    ])
    await expect(
      fileToMessageImage(new File([heic], 'IMG_0001.HEIC', { type: 'image/heic' }))
    ).rejects.toThrow('HEIC')
    await expect(
      fileToMessageImage(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
    ).rejects.toThrow()
  })

  it('refuses a damaged image that does not decode', async () => {
    decode.mockRejectedValueOnce(new Error('The source image could not be decoded.'))
    await expect(
      fileToMessageImage(new File([PIXEL_PNG.subarray(0, 40)], 'cut.png', { type: 'image/png' }))
    ).rejects.toThrow('cut.png')
  })
})
