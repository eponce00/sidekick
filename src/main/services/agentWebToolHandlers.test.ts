import { describe, expect, it } from 'vitest'
import { toOpenAICompatibleMessages } from '../providers/providerRuntime'
import { imageSearchToolResult } from './agentWebToolHandlers'
import type { ImageSearchResult } from './sidekickSearch/types'

const LARGE_IMAGE_BASE64 = 'QUFB'.repeat(30_000)

function imageResult(overrides: Partial<ImageSearchResult> = {}): ImageSearchResult {
  return {
    title: 'Controller reference',
    imageUrl: 'https://images.example/controller.jpg',
    thumbnailUrl: 'https://images.example/controller-thumb.jpg',
    pageUrl: 'https://example.com/controller',
    source: 'Example',
    resolution: '1200×800',
    mimeType: 'image/jpeg',
    imageBase64: LARGE_IMAGE_BASE64,
    ...overrides
  }
}

describe('agent web image results', () => {
  it('keeps image bytes out of model text and UI search metadata', () => {
    const result = imageSearchToolResult('Image search: controller', [
      imageResult(),
      imageResult({ title: 'Second result', imageBase64: 'QkJC'.repeat(100) })
    ])

    expect(result.modelContent.length).toBeLessThan(2_000)
    expect(result.modelContent).not.toContain(LARGE_IMAGE_BASE64)
    expect(result.modelContent).toContain('https://images.example/controller.jpg')
    expect(result.data?.results).toHaveLength(2)
    expect(result.data?.results[0]).not.toHaveProperty('imageBase64')
    expect(result.media).toHaveLength(1)
    expect(result.media?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
      source: { type: 'data_url', dataUrl: `data:image/jpeg;base64,${LARGE_IMAGE_BASE64}` }
    })
  })

  it('serializes visual bytes as a typed provider image instead of tool text', () => {
    const result = imageSearchToolResult('Image search: controller', [imageResult()])
    const messages = toOpenAICompatibleMessages([
      {
        role: 'tool',
        tool_call_id: 'search-1',
        content: result.modelContent,
        media: result.media
      }
    ])

    expect(messages[0]).toMatchObject({ role: 'tool', content: result.modelContent })
    expect(String(messages[0].content)).not.toContain(LARGE_IMAGE_BASE64)
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${LARGE_IMAGE_BASE64}` } }
      ])
    })
  })

  it('does not attach unsupported image types', () => {
    const result = imageSearchToolResult('Image search: controller', [
      imageResult({ mimeType: 'image/avif' })
    ])

    expect(result.media).toBeUndefined()
    expect(result.modelContent).toContain('"visualAttachments":0')
  })
})
