import { describe, expect, it } from 'vitest'
import { canonicalSearchUrl, fuseSearchResults } from './fusion'

describe('embedded search result fusion', () => {
  it('canonicalizes tracking variants into one destination', () => {
    expect(canonicalSearchUrl('https://WWW.Example.com/post/?utm_source=x&b=2&a=1#top')).toBe(
      'https://example.com/post?a=1&b=2'
    )
  })

  it('rewards cross-source consensus and preserves source attribution', () => {
    const results = fuseSearchResults(
      'sidekick search',
      [
        [
          {
            title: 'Sidekick Search',
            url: 'https://example.com/search?utm_source=ddg',
            description: 'Search locally',
            source: 'duckduckgo',
            rank: 2
          }
        ],
        [
          {
            title: 'Sidekick Search Engine',
            url: 'https://www.example.com/search',
            description: 'A longer description of Sidekick Search',
            source: 'brave',
            rank: 4
          },
          {
            title: 'Another result',
            url: 'https://another.test/',
            description: '',
            source: 'brave',
            rank: 1
          }
        ]
      ],
      5
    )

    expect(results[0]).toMatchObject({
      url: 'https://example.com/search',
      sources: ['duckduckgo', 'brave'],
      description: 'A longer description of Sidekick Search'
    })
  })

  it('limits domain repetition before filling with deferred results', () => {
    const results = fuseSearchResults(
      'query',
      [
        [1, 2, 3, 4].map((rank) => ({
          title: `Example ${rank}`,
          url: `https://example.com/${rank}`,
          description: 'query',
          source: 'duckduckgo' as const,
          rank
        })),
        [
          {
            title: 'Different',
            url: 'https://different.test/page',
            description: 'query',
            source: 'brave' as const,
            rank: 5
          }
        ]
      ],
      4
    )

    expect(results.slice(0, 3).map((result) => new URL(result.url).hostname)).toEqual([
      'example.com',
      'example.com',
      'different.test'
    ])
  })
})
