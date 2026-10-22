import { describe, expect, it } from 'vitest'
import { parseMessageImages, validateMessageImages } from './messageImages'

// A whole 1x1 PNG.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function pngDeclaring(width: number, height: number): string {
  const bytes = Uint8Array.from(atob(PIXEL_PNG), (character) => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

const image = {
  id: 'image-1',
  name: 'clipboard.png',
  mimeType: 'image/png' as const,
  dataUrl: 'data:image/png;base64,aGVsbG8='
}

describe('message images', () => {
  it('round-trips valid persisted attachments', () => {
    expect(parseMessageImages(JSON.stringify([image]))).toEqual([image])
  })

  it('rejects unsupported or mismatched image data', () => {
    expect(() => validateMessageImages([{ ...image, mimeType: 'image/jpeg' }])).toThrowError(
      'Invalid message image attachment'
    )
    expect(() => validateMessageImages([{ ...image, mimeType: 'image/svg+xml' }])).toThrowError(
      'Invalid message image attachment'
    )
  })

  it('accepts a real image and refuses bytes that are not the image they claim to be', () => {
    const pixel = { ...image, dataUrl: `data:image/png;base64,${PIXEL_PNG}` }
    expect(validateMessageImages([pixel])).toEqual([pixel])
    // Text labelled as a PNG, and a PNG labelled as a JPEG.
    expect(() => validateMessageImages([image])).toThrowError('Invalid message image attachment')
    expect(() =>
      validateMessageImages([
        { ...image, mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${PIXEL_PNG}` }
      ])
    ).toThrowError('Invalid message image attachment')
  })

  it('refuses an image that declares more pixels than SideKick decodes', () => {
    expect(() =>
      validateMessageImages([
        { ...image, dataUrl: `data:image/png;base64,${pngDeclaring(60_000, 60_000)}` }
      ])
    ).toThrowError('Invalid message image attachment')
    expect(
      validateMessageImages([
        { ...image, dataUrl: `data:image/png;base64,${pngDeclaring(7680, 4320)}` }
      ])
    ).toHaveLength(1)
  })

  it('takes the formats Chromium shows and the main process converts', () => {
    for (const mimeType of ['image/avif', 'image/bmp']) {
      expect(
        parseMessageImages(
          JSON.stringify([{ ...image, mimeType, dataUrl: `data:${mimeType};base64,AAAA` }])
        )
      ).toHaveLength(1)
    }
    expect(
      parseMessageImages(
        JSON.stringify([
          { ...image, mimeType: 'image/heic', dataUrl: 'data:image/heic;base64,AAAA' }
        ])
      )
    ).toEqual([])
  })

  it('treats malformed persisted data as having no attachments', () => {
    expect(parseMessageImages('{not json')).toEqual([])
  })
})
