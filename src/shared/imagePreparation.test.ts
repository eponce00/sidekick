import { describe, expect, it } from 'vitest'
import {
  describeImageReduction,
  planImagePreparation,
  providerImageProfile,
  type ImageSourceInfo
} from './imagePreparation'

const screenshot: ImageSourceInfo = {
  mimeType: 'image/png',
  width: 5120,
  height: 2880,
  bytes: 21 * 1024 * 1024
}

describe('provider image profiles', () => {
  it('fits each provider to what its servers and models take', () => {
    const anthropic = providerImageProfile('anthropic')
    expect(anthropic).toMatchObject({ maxLongEdge: 2000, maxImages: 4 })
    // 5 MB once base64-encoded, which Bedrock and Vertex also accept.
    expect(Math.ceil(anthropic.maxBytes / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(providerImageProfile('openrouter')).toEqual(anthropic)

    for (const kind of ['lmstudio', 'llamacpp', 'ollama', 'ollama-cloud'] as const) {
      const local = providerImageProfile(kind)
      expect(local.formats).toEqual(['image/png', 'image/jpeg'])
      expect(local.maxPixels).toBe(1_310_720)
      expect(local.maxImages).toBe(2)
    }
    expect(providerImageProfile('openai-compatible')).toMatchObject({
      maxLongEdge: 2048,
      maxImages: 2
    })
    expect(providerImageProfile(undefined)).toEqual(providerImageProfile('litellm'))
  })
})

describe('image preparation plans', () => {
  it('leaves an image that already fits untouched', () => {
    expect(
      planImagePreparation(
        { mimeType: 'image/png', width: 64, height: 32, bytes: 900 },
        providerImageProfile('anthropic')
      )
    ).toEqual({ width: 64, height: 32, resize: false, reencode: false })
  })

  it('shrinks to the long edge and keeps the aspect ratio', () => {
    const plan = planImagePreparation(screenshot, providerImageProfile('anthropic'))
    expect(plan).toEqual({ width: 2000, height: 1125, resize: true, reencode: true })
  })

  it('holds local models to their pixel budget as well as the long edge', () => {
    const plan = planImagePreparation(screenshot, providerImageProfile('lmstudio'))
    expect(plan.width * plan.height).toBeLessThanOrEqual(1_310_720)
    expect(plan.width / plan.height).toBeCloseTo(16 / 9, 2)
    const panorama = planImagePreparation(
      { mimeType: 'image/jpeg', width: 12_000, height: 1_500, bytes: 4_000_000 },
      providerImageProfile('ollama')
    )
    expect(panorama).toMatchObject({ width: 1568, height: 196 })
  })

  it('keeps a screenshot the model points into at its own size, re-encoding it to fit', () => {
    const viewport = { mimeType: 'image/png' as const, width: 2560, height: 1440, bytes: 6e6 }
    expect(
      planImagePreparation(viewport, providerImageProfile('lmstudio'), { keepDimensions: true })
    ).toEqual({ width: 2560, height: 1440, resize: false, reencode: true })
    // Beyond what any provider takes, even a pointed-at image must shrink.
    expect(
      planImagePreparation(
        { ...viewport, width: 16_000, height: 4_000 },
        providerImageProfile('anthropic'),
        { keepDimensions: true }
      )
    ).toMatchObject({ width: 8000, height: 2000, resize: true })
  })

  it('converts formats a provider cannot decode, and rotates EXIF-turned photos upright', () => {
    const small = { width: 800, height: 600, bytes: 50_000 }
    expect(
      planImagePreparation({ ...small, mimeType: 'image/webp' }, providerImageProfile('llamacpp'))
        .reencode
    ).toBe(true)
    expect(
      planImagePreparation({ ...small, mimeType: 'image/webp' }, providerImageProfile('anthropic'))
        .reencode
    ).toBe(false)
    for (const mimeType of ['image/gif', 'image/avif', 'image/bmp'] as const) {
      expect(
        planImagePreparation({ ...small, mimeType }, providerImageProfile('anthropic')).reencode
      ).toBe(true)
    }
    expect(
      planImagePreparation(
        { ...small, mimeType: 'image/jpeg', orientation: 6 },
        providerImageProfile('anthropic')
      )
    ).toMatchObject({ width: 800, height: 600, resize: false, reencode: true })
  })
})

describe('image reduction notices', () => {
  it('says when the model receives a smaller copy, and stays quiet otherwise', () => {
    expect(describeImageReduction(screenshot, providerImageProfile('anthropic'))).toContain(
      '2000 × 1125'
    )
    expect(
      describeImageReduction(
        { mimeType: 'image/webp', width: 800, height: 600, bytes: 60_000 },
        providerImageProfile('lmstudio')
      )
    ).toBeUndefined()
  })
})
