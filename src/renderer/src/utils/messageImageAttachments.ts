import {
  isSupportedMessageImageMimeType,
  MAX_MESSAGE_IMAGE_BYTES,
  type MessageImageAttachment
} from '../../../shared/messageImages'

export function clipboardImageFiles(items: ArrayLike<DataTransferItem>): File[] {
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

export function fileToMessageImage(file: File): Promise<MessageImageAttachment> {
  const mimeType = file.type.toLowerCase()
  if (!isSupportedMessageImageMimeType(mimeType)) {
    return Promise.reject(new Error('Use a PNG, JPEG, WebP, or GIF image'))
  }
  if (file.size <= 0 || file.size > MAX_MESSAGE_IMAGE_BYTES) {
    return Promise.reject(new Error('Each image must be smaller than 8 MB'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
        reject(new Error(`Could not decode ${file.name || 'image'}`))
        return
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || `clipboard-${Date.now()}.${mimeType.split('/')[1] || 'png'}`,
        mimeType,
        dataUrl
      })
    }
    reader.readAsDataURL(file)
  })
}
