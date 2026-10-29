import { imageHeader, imageSignature, isHeifImage } from '../../../shared/imageContent'
import { MAX_IMAGE_INPUT_DIMENSION, MAX_IMAGE_INPUT_PIXELS } from '../../../shared/imagePreparation'
import {
  isSupportedMessageImageMimeType,
  MAX_MESSAGE_IMAGE_BYTES,
  type MessageImageAttachment
} from '../../../shared/messageImages'

// Enough for any header, including a JPEG's EXIF block and embedded thumbnail.
const HEADER_BYTES = 1024 * 1024

function readFile<T extends string | ArrayBuffer>(
  file: File,
  start: (reader: FileReader) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}`))
    reader.onload = () => resolve(reader.result as T)
    start(reader)
  })
}

/**
 * Takes any image Chromium can show, at any size a real photo or screenshot has. Only the copy
 * sent to a model is reduced, in the main process, to what that model accepts.
 */
export async function fileToMessageImage(file: File): Promise<MessageImageAttachment> {
  const label = file.name || 'This image'
  if (file.size <= 0) throw new Error(`${label} is empty`)
  if (file.size > MAX_MESSAGE_IMAGE_BYTES) {
    throw new Error(`${label} is over 100 MB. Attach a smaller copy.`)
  }
  const head = new Uint8Array(
    await readFile<ArrayBuffer>(file, (reader) =>
      reader.readAsArrayBuffer(file.slice(0, HEADER_BYTES))
    )
  )
  if (isHeifImage(head)) {
    throw new Error(`${label} is a HEIC photo, which SideKick can't read yet. Export it as JPEG.`)
  }
  // The bytes decide the format; a pasted file's type or a file's extension can be wrong.
  const mimeType = imageSignature(head)
  if (!mimeType || !isSupportedMessageImageMimeType(mimeType)) {
    throw new Error('Use a PNG, JPEG, WebP, GIF, AVIF, or BMP image')
  }
  const header = imageHeader(head)
  if (
    header &&
    (header.width > MAX_IMAGE_INPUT_DIMENSION ||
      header.height > MAX_IMAGE_INPUT_DIMENSION ||
      header.width * header.height > MAX_IMAGE_INPUT_PIXELS)
  ) {
    throw new Error(
      `${label} is ${header.width} × ${header.height} pixels, more than SideKick can open.`
    )
  }
  try {
    // Decoding proves the whole file is an image, before it is attached and sent.
    const bitmap = await createImageBitmap(file)
    bitmap.close()
  } catch {
    throw new Error(`${label} could not be read. The file may be damaged.`)
  }
  const dataUrl = await readFile<string>(file, (reader) => reader.readAsDataURL(file))
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
  if (!dataUrl.startsWith('data:') || !encoded) throw new Error(`Could not read ${label}`)
  return {
    id: crypto.randomUUID(),
    name: file.name || `clipboard-${Date.now()}.${mimeType.split('/')[1]}`,
    mimeType,
    dataUrl: `data:${mimeType};base64,${encoded}`
  }
}
