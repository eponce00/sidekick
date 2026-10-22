import { createHash } from 'node:crypto'
import type { ToolResultImageMimeType, ToolResultMediaAttachment } from '../../shared/agentRuntime'
import { imageContentType, imageHeader } from '../../shared/imageContent'
import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUT_DIMENSION,
  MAX_IMAGE_INPUT_PIXELS,
  planImagePreparation,
  type ImagePreparationOptions,
  type ProviderImageProfile
} from '../../shared/imagePreparation'
import type { ProviderChatMessage } from '../../shared/providerRuntime'

export interface PreparedImage {
  mimeType: ToolResultImageMimeType
  bytes: Buffer
  width: number
  height: number
  /** The size it had before, when it was made smaller. */
  resizedFrom?: { width: number; height: number }
}

export type ImagePreparationResult =
  | ({ ok: true } & PreparedImage)
  | { ok: false; reason: 'unreadable' | 'too_large' }

// Lossless first keeps screenshot text sharp; the JPEG steps stay above the range where
// compression smears small text.
const JPEG_QUALITIES = [85, 75, 60]
const SHRINK_STEP = 0.75
const SHRINK_ATTEMPTS = 6

type CanvasModule = typeof import('@napi-rs/canvas')
let canvasModule: Promise<CanvasModule> | null = null

function canvas(): Promise<CanvasModule> {
  canvasModule ??= import('@napi-rs/canvas')
  return canvasModule
}

async function encode(
  module: CanvasModule,
  image: InstanceType<CanvasModule['Image']>,
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  quality?: number
): Promise<Buffer> {
  const surface = module.createCanvas(width, height)
  const context = surface.getContext('2d')
  // JPEG has no transparency; without a backdrop transparent pixels turn black.
  if (format === 'jpeg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  context.imageSmoothingEnabled = true
  // Skia's "medium" samples from mipmaps, which averages the pixels a large reduction drops.
  // "high" is bicubic without them, and breaks small screenshot text apart at a third of the size.
  context.imageSmoothingQuality = 'medium'
  context.drawImage(image, 0, 0, width, height)
  return format === 'png' ? surface.encode('png') : surface.encode('jpeg', quality)
}

async function reencode(
  bytes: Buffer,
  sourceIsJpeg: boolean,
  width: number,
  height: number,
  maxBytes: number
): Promise<PreparedImage | undefined> {
  const module = await canvas()
  // The decoder applies EXIF rotation, so its size is the header's displayed size.
  const image = await module.loadImage(bytes)
  if (!image.width || !image.height) return undefined
  const tryPng = !sourceIsJpeg
  for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt++) {
    if (tryPng) {
      const png = await encode(module, image, width, height, 'png')
      if (png.byteLength <= maxBytes) return { mimeType: 'image/png', bytes: png, width, height }
    }
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await encode(module, image, width, height, 'jpeg', quality)
      if (jpeg.byteLength <= maxBytes) return { mimeType: 'image/jpeg', bytes: jpeg, width, height }
    }
    width = Math.max(1, Math.round(width * SHRINK_STEP))
    height = Math.max(1, Math.round(height * SHRINK_STEP))
  }
  return undefined
}

/** Whether an image's declared size is one SideKick refuses to decode. */
export function exceedsImageInputLimits(width: number, height: number, bytes: number): boolean {
  return (
    bytes > MAX_IMAGE_INPUT_BYTES ||
    width > MAX_IMAGE_INPUT_DIMENSION ||
    height > MAX_IMAGE_INPUT_DIMENSION ||
    width * height > MAX_IMAGE_INPUT_PIXELS
  )
}

async function prepare(
  bytes: Buffer,
  profile: ProviderImageProfile,
  options: ImagePreparationOptions
): Promise<ImagePreparationResult> {
  const header = imageHeader(bytes)
  // A PNG cut short still decodes, with the missing rows left blank.
  if (!header || !header.width || !header.height) return { ok: false, reason: 'unreadable' }
  if (header.mimeType === 'image/png' && !imageContentType(bytes)) {
    return { ok: false, reason: 'unreadable' }
  }
  if (exceedsImageInputLimits(header.width, header.height, bytes.byteLength)) {
    return { ok: false, reason: 'too_large' }
  }
  const plan = planImagePreparation({ ...header, bytes: bytes.byteLength }, profile, options)
  if (!plan.reencode) {
    return {
      ok: true,
      // Only a format the profile accepts is sent unchanged.
      mimeType: header.mimeType as ToolResultImageMimeType,
      bytes,
      width: header.width,
      height: header.height
    }
  }
  let prepared: PreparedImage | undefined
  try {
    prepared = await reencode(
      bytes,
      header.mimeType === 'image/jpeg',
      plan.width,
      plan.height,
      profile.maxBytes
    )
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!prepared) return { ok: false, reason: 'too_large' }
  return {
    ok: true,
    ...prepared,
    ...(prepared.width !== header.width || prepared.height !== header.height
      ? { resizedFrom: { width: header.width, height: header.height } }
      : {})
  }
}

// Every turn of a run resends the conversation's images, so each is prepared once. Bounded by
// the bytes it holds; Codex keeps a 64 MiB cache for the same reason.
const CACHE_BYTES = 64 * 1024 * 1024
const cache = new Map<string, Promise<ImagePreparationResult>>()
const cachedBytes = new Map<string, number>()
let cacheTotal = 0

function remember(key: string, result: ImagePreparationResult): void {
  if (!cache.has(key)) return
  const size = result.ok ? result.bytes.byteLength : 0
  cachedBytes.set(key, size)
  cacheTotal += size
  for (const oldest of cache.keys()) {
    if (cacheTotal <= CACHE_BYTES) break
    cacheTotal -= cachedBytes.get(oldest) ?? 0
    cachedBytes.delete(oldest)
    cache.delete(oldest)
  }
}

/** Fits one image to what a provider accepts; images that already fit come back unchanged. */
export function prepareProviderImage(
  bytes: Buffer,
  profile: ProviderImageProfile,
  options: ImagePreparationOptions = {}
): Promise<ImagePreparationResult> {
  const key = createHash('sha256')
    .update(JSON.stringify([profile, options.keepDimensions === true]))
    .update(bytes)
    .digest('hex')
  const cached = cache.get(key)
  if (cached) {
    // Most recently used goes last, so eviction takes the oldest.
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const pending = prepare(bytes, profile, options)
  cache.set(key, pending)
  void pending.then(
    (result) => remember(key, result),
    () => {
      cache.delete(key)
    }
  )
  return pending
}

export function clearProviderImageCache(): void {
  cache.clear()
  cachedBytes.clear()
  cacheTotal = 0
}

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i

function dataUrlBytes(dataUrl: string): Buffer | undefined {
  const prefix = DATA_URL.exec(dataUrl)
  return prefix ? Buffer.from(dataUrl.slice(prefix[0].length), 'base64') : undefined
}

function dataUrl(image: PreparedImage): string {
  return `data:${image.mimeType};base64,${image.bytes.toString('base64')}`
}

function sizeText(size: { width: number; height: number }): string {
  return `${size.width}×${size.height}`
}

/** Says what happened to an image the model would otherwise silently see smaller or not at all. */
function preparationNote(label: string, result: ImagePreparationResult): string | undefined {
  if (!result.ok) {
    return result.reason === 'too_large'
      ? `[${label} is too large to send, so it was left out.]`
      : `[${label} could not be read, so it was left out.]`
  }
  return result.resizedFrom
    ? `[${label} was resized from ${sizeText(result.resizedFrom)} to ${sizeText(result)} to fit this model.]`
    : undefined
}

async function prepareDataUrl(
  value: string,
  profile: ProviderImageProfile,
  options: ImagePreparationOptions
): Promise<{ result: ImagePreparationResult; dataUrl?: string }> {
  const bytes = dataUrlBytes(value)
  if (!bytes) return { result: { ok: false, reason: 'unreadable' } }
  const result = await prepareProviderImage(bytes, profile, options)
  if (!result.ok) return { result }
  return { result, dataUrl: result.bytes === bytes ? value : dataUrl(result) }
}

/**
 * The provider's copy of a message, with each image fitted to what it accepts. The stored message
 * keeps the original. Runs at the provider boundary, after file-backed media is read.
 */
export async function prepareMessageImages(
  message: ProviderChatMessage,
  profile: ProviderImageProfile
): Promise<ProviderChatMessage> {
  if (!message.images?.length && !message.media?.length) return message
  const notes: string[] = []
  let changed = false

  const images: string[] = []
  const attached = message.images ?? []
  for (const [index, value] of attached.entries()) {
    const label = attached.length > 1 ? `Attached image ${index + 1}` : 'The attached image'
    const { result, dataUrl: prepared } = await prepareDataUrl(value, profile, {})
    const note = preparationNote(label, result)
    if (note) notes.push(note)
    if (prepared) images.push(prepared)
    changed ||= prepared !== value
  }

  const media: ToolResultMediaAttachment[] = []
  for (const attachment of message.media ?? []) {
    if (attachment.type !== 'image' || attachment.source.type !== 'data_url') {
      media.push(attachment)
      continue
    }
    const { result, dataUrl: prepared } = await prepareDataUrl(attachment.source.dataUrl, profile, {
      keepDimensions: attachment.keepDimensions === true
    })
    if (!result.ok || !prepared) {
      const label = attachment.name || 'A tool image'
      notes.push(
        preparationNote(label, result) ?? `[${label} could not be read, so it was left out.]`
      )
      changed = true
      continue
    }
    if (prepared === attachment.source.dataUrl) {
      media.push(attachment)
      continue
    }
    changed = true
    media.push({
      ...attachment,
      mimeType: result.mimeType,
      source: { type: 'data_url', dataUrl: prepared },
      ...(result.resizedFrom
        ? {
            description: `${attachment.description || attachment.name || 'Tool image'} (resized from ${sizeText(result.resizedFrom)} to ${sizeText(result)})`
          }
        : {})
    })
  }

  if (!changed) return message
  const content = notes.length
    ? [message.content, ...notes].filter(Boolean).join('\n')
    : message.content
  return {
    ...message,
    content,
    images: images.length ? images : undefined,
    media: message.media ? (media.length ? media : undefined) : undefined
  }
}
