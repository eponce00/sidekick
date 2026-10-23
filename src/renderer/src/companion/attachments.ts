import { COMPANION_UPLOAD_CHUNK_BYTES, type CompanionCalls } from '../../../shared/companion'
import { bytesToBase64 } from './audio'
import type { CompanionConnection } from './chatState'

/** The longest side of a photo sent from the phone; the model gets a smaller copy if it needs one. */
export const PHONE_IMAGE_SIDE = 2560
export const PHONE_JPEG_QUALITY = 0.85
/** A PNG this small, such as a screenshot, keeps its sharp edges instead of becoming a JPEG. */
export const KEEP_PNG_BYTES = 2 * 1024 * 1024
/** The largest text file the phone sends; the computer refuses larger ones too. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

/** What the File option offers: text and code, never documents or archives. */
export const TEXT_FILE_ACCEPT = [
  'text/*',
  'application/json',
  'application/xml',
  ...[
    'txt',
    'md',
    'markdown',
    'csv',
    'tsv',
    'json',
    'jsonl',
    'yaml',
    'yml',
    'xml',
    'toml',
    'ini',
    'conf',
    'cfg',
    'env',
    'log',
    'html',
    'css',
    'scss',
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'swift',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'php',
    'sh',
    'ps1',
    'bat',
    'sql',
    'graphql',
    'vue',
    'svelte'
  ].map((extension) => `.${extension}`)
].join(',')

export interface ImagePlan {
  /** Send the file as it is. */
  keep: boolean
  width: number
  height: number
  mimeType: string
}

/** How a photo is sent: as it is when it is a small PNG, otherwise as a JPEG of bounded size. */
export function imagePlan(
  file: { type: string; size: number },
  width: number,
  height: number
): ImagePlan {
  const scale = Math.min(1, PHONE_IMAGE_SIDE / Math.max(width, height, 1))
  const fits = scale === 1
  if (file.type === 'image/png' && file.size < KEEP_PNG_BYTES && fits)
    return { keep: true, width, height, mimeType: 'image/png' }
  return {
    keep: false,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    mimeType: 'image/jpeg'
  }
}

/** Why a file cannot go as text, in words the phone shows, or null when it can. */
export function textFileProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT_FILE_BYTES)
    return `${name} is larger than 2 MB. Send a smaller text file.`
  // A text file has no NUL characters and few replacement characters; a binary one has both,
  // which is how the computer tells them apart too.
  if (bytes.includes(0)) return `${name} is not a text file. Attach images or text files.`
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if ((text.match(/�/g)?.length ?? 0) > text.length / 100)
    return `${name} is not a text file. Attach images or text files.`
  return null
}

/** The byte ranges a file goes up in, one request each. */
export function uploadPieces(
  length: number,
  size = COMPANION_UPLOAD_CHUNK_BYTES
): Array<[number, number]> {
  const pieces: Array<[number, number]> = []
  for (let start = 0; start < length; start += size)
    pieces.push([start, Math.min(length, start + size)])
  // An empty file still needs one request to exist.
  return pieces.length ? pieces : [[0, 0]]
}

/** Sends a file to the computer in pieces, reporting how much has gone; resolves to its id. */
export async function uploadBytes(
  connection: CompanionConnection,
  file: {
    kind: CompanionCalls['upload.put']['input']['kind']
    name: string
    mimeType: string
    bytes: Uint8Array
  },
  onProgress?: (fraction: number) => void
): Promise<string> {
  let uploadId: string | undefined
  const pieces = uploadPieces(file.bytes.length)
  for (const [index, [start, end]] of pieces.entries()) {
    const last = index === pieces.length - 1
    const result = await connection.call('upload.put', {
      ...(uploadId ? { uploadId } : {}),
      kind: file.kind,
      name: file.name,
      mimeType: file.mimeType,
      data: bytesToBase64(file.bytes.subarray(start, end)),
      last
    })
    uploadId = result.uploadId
    onProgress?.(file.bytes.length ? end / file.bytes.length : 1)
  }
  return uploadId!
}

async function decodeImage(
  file: File
): Promise<CanvasImageSource & { width: number; height: number }> {
  // Applies the photo's orientation, and reads the file without an object URL, which the
  // page's policy does not let an image load from.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      /* Older browsers take no options; the data URL below still works. */
    }
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the photo'))
    reader.readAsDataURL(file)
  })
  const image = new Image()
  image.decoding = 'async'
  image.src = dataUrl
  await image.decode()
  return Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the photo'))
    reader.readAsDataURL(blob)
  })
}

export interface PreparedImage {
  name: string
  mimeType: string
  bytes: Uint8Array
  /** A copy for the chip and the lightbox. */
  dataUrl: string
}

/** Reduces a photo on the phone before it is sent, so a large camera image uploads quickly. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  let source: Awaited<ReturnType<typeof decodeImage>>
  try {
    source = await decodeImage(file)
  } catch {
    throw new Error(`${file.name || 'That photo'} could not be read as an image.`)
  }
  const plan = imagePlan(file, source.width, source.height)
  const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '')
  if (plan.keep) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return {
      name: file.name || 'image.png',
      mimeType: plan.mimeType,
      bytes,
      dataUrl: await blobToDataUrl(file)
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This phone could not prepare the photo.')
  // A transparent PNG becomes a JPEG on white rather than black.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, plan.width, plan.height)
  context.drawImage(source, 0, 0, plan.width, plan.height)
  if ('close' in source && typeof source.close === 'function') source.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, plan.mimeType, PHONE_JPEG_QUALITY)
  )
  if (!blob) throw new Error('This phone could not prepare the photo.')
  return {
    name: `${baseName}.jpg`,
    mimeType: plan.mimeType,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    dataUrl: await blobToDataUrl(blob)
  }
}
