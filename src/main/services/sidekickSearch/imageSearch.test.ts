import { describe, expect, it } from 'vitest'
import { normalizeImageResults } from './imageSearch'

describe('embedded image search', () => {
  it('normalizes, deduplicates, and validates discovered images', () => {
    expect(
      normalizeImageResults(
        [
          {
            title: 'Example',
            image: 'https://images.test/full.jpg',
            thumbnail: 'https://images.test/thumb.jpg',
            url: 'https://example.test/page',
            source: 'Example',
            width: 1200,
            height: 800
          },
          {
            image: 'https://images.test/full.jpg',
            url: 'https://example.test/duplicate'
          },
          { image: 'data:image/png;base64,x', url: 'https://example.test/invalid' }
        ],
        5
      )
    ).toEqual([
      {
        title: 'Example',
        imageUrl: 'https://images.test/full.jpg',
        thumbnailUrl: 'https://images.test/thumb.jpg',
        pageUrl: 'https://example.test/page',
        source: 'Example',
        resolution: '1200×800'
      }
    ])
  })
})
