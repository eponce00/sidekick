import { describe, expect, it } from 'vitest'
import { parseMessageImages, validateMessageImages } from './messageImages'

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

  it('treats malformed persisted data as having no attachments', () => {
    expect(parseMessageImages('{not json')).toEqual([])
  })
})
