import { dataUrlHead, imageHeader, imageSignature } from './imageContent'
import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUT_DIMENSION,
  MAX_IMAGE_INPUT_PIXELS
} from './imagePreparation'

export const MAX_MESSAGE_IMAGES = 4
/** The original is kept; only the copy sent to a model is reduced to what it accepts. */
export const MAX_MESSAGE_IMAGE_BYTES = MAX_IMAGE_INPUT_BYTES
export const MAX_MESSAGE_IMAGE_DATA_URL_LENGTH = Math.ceil((MAX_MESSAGE_IMAGE_BYTES * 4) / 3) + 256
/** A message is one JSON string in its row and its IPC call, so its images share a bound. */
export const MAX_MESSAGE_IMAGES_TOTAL_BYTES = 2 * MAX_IMAGE_INPUT_BYTES

// Chromium shows all of these; the main process converts AVIF and BMP for providers.
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp'
])

export interface MessageImageAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}

export function isSupportedMessageImageMimeType(value: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(value.toLowerCase())
}

export function parseMessageImages(value: string | null | undefined): MessageImageAttachment[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return []
        const image = candidate as Record<string, unknown>
        const id = typeof image.id === 'string' ? image.id : ''
        const name = typeof image.name === 'string' ? image.name : ''
        const mimeType = typeof image.mimeType === 'string' ? image.mimeType.toLowerCase() : ''
        const dataUrl = typeof image.dataUrl === 'string' ? image.dataUrl : ''
        if (
          !id ||
          id.length > 200 ||
          !name ||
          name.length > 500 ||
          !isSupportedMessageImageMimeType(mimeType) ||
          dataUrl.length > MAX_MESSAGE_IMAGE_DATA_URL_LENGTH ||
          !dataUrl.startsWith(`data:${mimeType};base64,`)
        ) {
          return []
        }
        return [{ id, name, mimeType, dataUrl }]
      })
      .slice(0, MAX_MESSAGE_IMAGES)
  } catch {
    return []
  }
}

/** Enough of the image to hold any header SideKick reads, including a JPEG's EXIF block. */
const HEADER_BYTES = 1024 * 1024

/** Approximate decoded size of a base64 data URL, without decoding it. */
export function dataUrlByteLength(dataUrl: string): number {
  const encoded = dataUrl.length - dataUrl.indexOf(',') - 1
  return Math.floor((encoded * 3) / 4)
}

/**
 * The bytes must be the image they claim to be, and not declare more pixels than SideKick will
 * decode. The renderer checks the same before attaching; this is the boundary that counts.
 */
export function isReadableMessageImage(
  image: Pick<MessageImageAttachment, 'mimeType' | 'dataUrl'>
): boolean {
  const head = dataUrlHead(image.dataUrl, HEADER_BYTES)
  if (!head || imageSignature(head) !== image.mimeType) return false
  const header = imageHeader(head)
  // A JPEG may keep its size past the header block; the provider boundary reads it in full.
  if (!header) return image.mimeType === 'image/jpeg'
  return (
    header.width > 0 &&
    header.height > 0 &&
    header.width <= MAX_IMAGE_INPUT_DIMENSION &&
    header.height <= MAX_IMAGE_INPUT_DIMENSION &&
    header.width * header.height <= MAX_IMAGE_INPUT_PIXELS
  )
}

export function validateMessageImages(value: unknown): MessageImageAttachment[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_IMAGES) {
    throw new Error(`A message can contain up to ${MAX_MESSAGE_IMAGES} images`)
  }
  // Checked before the JSON round trip, which would otherwise build one string of all of them.
  const total = value.reduce<number>((sum, candidate) => {
    const dataUrl = (candidate as Partial<MessageImageAttachment> | null)?.dataUrl
    return sum + (typeof dataUrl === 'string' ? dataUrlByteLength(dataUrl) : 0)
  }, 0)
  if (total > MAX_MESSAGE_IMAGES_TOTAL_BYTES) {
    throw new Error(
      `The images in one message must add up to less than ${MAX_MESSAGE_IMAGES_TOTAL_BYTES / 1024 / 1024} MB`
    )
  }
  const normalized = parseMessageImages(JSON.stringify(value))
  if (normalized.length !== value.length || !normalized.every(isReadableMessageImage)) {
    throw new Error('Invalid message image attachment')
  }
  return normalized
}
