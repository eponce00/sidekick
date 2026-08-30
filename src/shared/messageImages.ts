export const MAX_MESSAGE_IMAGES = 4
export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_MESSAGE_IMAGE_DATA_URL_LENGTH = Math.ceil((MAX_MESSAGE_IMAGE_BYTES * 4) / 3) + 256

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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

export function validateMessageImages(value: unknown): MessageImageAttachment[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_IMAGES) {
    throw new Error(`A message can contain up to ${MAX_MESSAGE_IMAGES} images`)
  }
  const normalized = parseMessageImages(JSON.stringify(value))
  if (normalized.length !== value.length) throw new Error('Invalid message image attachment')
  return normalized
}
