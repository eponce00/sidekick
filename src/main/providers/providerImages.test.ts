import { createCanvas } from '@napi-rs/canvas'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { imageHeader } from '../../shared/imageContent'
import { providerImageProfile } from '../../shared/imagePreparation'
import type { ProviderChatMessage } from '../../shared/providerRuntime'
import {
  clearProviderImageCache,
  prepareMessageImages,
  prepareProviderImage,
  type ImagePreparationResult,
  type PreparedImage
} from './providerImages'

/** Seeded noise compresses about as badly as a photo, so a PNG of it is as large as it looks. */
function noise(width: number, height: number, seed = 1): Buffer {
  const surface = createCanvas(width, height)
  const context = surface.getContext('2d')
  const pixels = context.createImageData(width, height)
  let state = seed
  for (let index = 0; index < pixels.data.length; index += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    pixels.data[index] = state & 0xff
    pixels.data[index + 1] = (state >>> 8) & 0xff
    pixels.data[index + 2] = (state >>> 16) & 0xff
    pixels.data[index + 3] = 0xff
  }
  context.putImageData(pixels, 0, 0)
  return surface.encodeSync('png')
}

/** Dark text on a light page, like a screenshot of an app. */
function page(width: number, height: number, format: 'png' | 'jpeg' | 'webp' = 'png'): Buffer {
  const surface = createCanvas(width, height)
  const context = surface.getContext('2d')
  context.fillStyle = '#f4f4f2'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#1d1d1b'
  context.font = '14px sans-serif'
  for (let y = 20; y < height; y += 22) context.fillText(`Line ${y} of a settings page`, 12, y)
  return format === 'png' ? surface.encodeSync('png') : surface.encodeSync(format, 90)
}

function expectPrepared(result: ImagePreparationResult): PreparedImage {
  expect(result.ok).toBe(true)
  return result as PreparedImage
}

function exifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const marker = Buffer.from([0xff, 0xe1, 0, 0])
  marker.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)])
}

describe('provider image preparation', () => {
  let largePng: Buffer

  beforeAll(() => {
    largePng = noise(2900, 2400)
  })

  beforeEach(() => clearProviderImageCache())

  it('fits a 20 MB PNG under each provider’s byte and size limits, keeping its shape', async () => {
    expect(largePng.byteLength).toBeGreaterThan(20 * 1024 * 1024)
    for (const kind of ['anthropic', 'openrouter', 'lmstudio', 'llamacpp', 'ollama'] as const) {
      const profile = providerImageProfile(kind)
      const prepared = expectPrepared(await prepareProviderImage(largePng, profile))
      expect(prepared.bytes.byteLength).toBeLessThanOrEqual(profile.maxBytes)
      expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(profile.maxLongEdge)
      expect(prepared.width * prepared.height).toBeLessThanOrEqual(profile.maxPixels ?? Infinity)
      expect(prepared.width / prepared.height).toBeCloseTo(2900 / 2400, 2)
      expect(prepared.resizedFrom).toEqual({ width: 2900, height: 2400 })
      // What is sent is what it says it is.
      expect(imageHeader(prepared.bytes)).toMatchObject({
        mimeType: prepared.mimeType,
        width: prepared.width,
        height: prepared.height
      })
      expect(profile.formats).toContain(prepared.mimeType)
    }
  }, 120_000)

  it('sends a tiny image byte for byte', async () => {
    const tiny = page(64, 48)
    const prepared = expectPrepared(
      await prepareProviderImage(tiny, providerImageProfile('anthropic'))
    )
    expect(prepared.bytes).toBe(tiny)
    expect(prepared).toMatchObject({ mimeType: 'image/png', width: 64, height: 48 })
    expect(prepared.resizedFrom).toBeUndefined()
  })

  it('brings a huge-dimension image inside the long edge and keeps screenshots lossless', async () => {
    const wide = page(12_000, 1_500)
    const prepared = expectPrepared(
      await prepareProviderImage(wide, providerImageProfile('lmstudio'))
    )
    expect(prepared).toMatchObject({ mimeType: 'image/png', width: 1568, height: 196 })
    expect(prepared.resizedFrom).toEqual({ width: 12_000, height: 1_500 })
  }, 60_000)

  it('converts what a provider cannot decode, and leaves it alone for one that can', async () => {
    const webp = page(400, 300, 'webp')
    const local = expectPrepared(await prepareProviderImage(webp, providerImageProfile('llamacpp')))
    expect(local).toMatchObject({ mimeType: 'image/png', width: 400, height: 300 })
    expect(local.resizedFrom).toBeUndefined()
    const cloud = expectPrepared(
      await prepareProviderImage(webp, providerImageProfile('anthropic'))
    )
    expect(cloud.bytes).toBe(webp)

    const gif = createCanvas(32, 16).encodeSync('gif', 90)
    const firstFrame = expectPrepared(
      await prepareProviderImage(gif, providerImageProfile('openrouter'))
    )
    expect(firstFrame).toMatchObject({ mimeType: 'image/png', width: 32, height: 16 })
  })

  it('keeps a viewport screenshot’s size and re-encodes it to fit the byte limit', async () => {
    const viewport = noise(1920, 1080, 7)
    const profile = providerImageProfile('lmstudio')
    expect(viewport.byteLength).toBeGreaterThan(profile.maxBytes)
    const prepared = expectPrepared(
      await prepareProviderImage(viewport, profile, { keepDimensions: true })
    )
    expect(prepared).toMatchObject({ mimeType: 'image/jpeg', width: 1920, height: 1080 })
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(profile.maxBytes)
  }, 60_000)

  it('turns an EXIF-rotated photo upright, so no provider shows it sideways', async () => {
    const landscape = createCanvas(300, 100).encodeSync('jpeg', 90)
    const rotated = exifOrientation(landscape, 6)
    expect(imageHeader(rotated)).toMatchObject({ width: 100, height: 300, orientation: 6 })
    const prepared = expectPrepared(
      await prepareProviderImage(rotated, providerImageProfile('anthropic'))
    )
    expect(prepared).toMatchObject({ mimeType: 'image/jpeg', width: 100, height: 300 })
    expect(imageHeader(prepared.bytes)?.orientation).toBeUndefined()
  })

  it('refuses a corrupt image instead of sending it', async () => {
    const profile = providerImageProfile('anthropic')
    expect(await prepareProviderImage(Buffer.from('not an image at all'), profile)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
    const cut = page(800, 600)
    expect(await prepareProviderImage(cut.subarray(0, cut.length / 2), profile)).toEqual({
      ok: false,
      reason: 'unreadable'
    })
    // A believable header over garbage gets as far as the decoder, which refuses it.
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    const garbage = Buffer.concat([noise(3000, 10).subarray(0, 33), Buffer.alloc(4096, 7), iend])
    expect(await prepareProviderImage(garbage, profile)).toMatchObject({ ok: false })
  })

  it('refuses a decompression bomb from its header, before decoding a pixel', async () => {
    const bomb = Buffer.from(page(1, 1))
    bomb.writeUInt32BE(60_000, 16)
    bomb.writeUInt32BE(60_000, 20)
    const started = performance.now()
    expect(await prepareProviderImage(bomb, providerImageProfile('anthropic'))).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('prepares each image once however many turns resend it', async () => {
    const profile = providerImageProfile('anthropic')
    const first = prepareProviderImage(largePng, profile)
    expect(prepareProviderImage(largePng, profile)).toBe(first)
    expect(prepareProviderImage(largePng, providerImageProfile('lmstudio'))).not.toBe(first)
    await first
  }, 60_000)
})

describe('provider message images', () => {
  beforeEach(() => clearProviderImageCache())

  const dataUrl = (image: Buffer, mimeType = 'image/png'): string =>
    `data:${mimeType};base64,${image.toString('base64')}`

  it('replaces only the provider copy and tells the model what was resized', async () => {
    const large = dataUrl(page(5120, 2880))
    const tiny = dataUrl(page(40, 30))
    const message: ProviderChatMessage = {
      role: 'user',
      content: 'What does this say?',
      images: [large, tiny]
    }
    const prepared = await prepareMessageImages(message, providerImageProfile('anthropic'))

    expect(message.images).toEqual([large, tiny])
    expect(prepared.images?.[1]).toBe(tiny)
    expect(prepared.images?.[0]).not.toBe(large)
    const sent = Buffer.from(prepared.images![0].split(',')[1], 'base64')
    expect(imageHeader(sent)).toMatchObject({ width: 2000, height: 1125 })
    expect(prepared.content).toBe(
      'What does this say?\n[Attached image 1 was resized from 5120×2880 to 2000×1125 to fit this model.]'
    )
  }, 60_000)

  it('leaves out an unreadable attachment with a note rather than failing the request', async () => {
    const message: ProviderChatMessage = {
      role: 'user',
      content: 'Look',
      images: ['data:image/png;base64,bm90IGFuIGltYWdl']
    }
    const prepared = await prepareMessageImages(message, providerImageProfile('lmstudio'))
    expect(prepared.images).toBeUndefined()
    expect(prepared.content).toBe(
      'Look\n[The attached image could not be read, so it was left out.]'
    )
  })

  it('returns a message whose images already fit as the same object', async () => {
    const message: ProviderChatMessage = {
      role: 'tool',
      tool_call_id: 'observe-1',
      content: 'Viewport',
      media: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: { type: 'data_url', dataUrl: dataUrl(page(320, 200)) },
          keepDimensions: true
        }
      ]
    }
    expect(await prepareMessageImages(message, providerImageProfile('anthropic'))).toBe(message)
  })

  it('notes a resized tool image in its description', async () => {
    const message: ProviderChatMessage = {
      role: 'tool',
      tool_call_id: 'view-1',
      content: 'Attached image photo.jpg',
      media: [
        {
          type: 'image',
          mimeType: 'image/jpeg',
          name: 'photo.jpg',
          description: 'Image selected by view_image',
          source: { type: 'data_url', dataUrl: dataUrl(page(4000, 3000, 'jpeg'), 'image/jpeg') }
        }
      ]
    }
    const prepared = await prepareMessageImages(message, providerImageProfile('ollama'))
    expect(prepared.media?.[0]).toMatchObject({
      mimeType: 'image/jpeg',
      description: 'Image selected by view_image (resized from 4000×3000 to 1321×991)'
    })
  }, 60_000)
})
