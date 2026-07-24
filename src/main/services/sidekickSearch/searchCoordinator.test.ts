import { describe, expect, it, vi } from 'vitest'
import type { SearchSource } from './source'
import { createSearchCoordinator } from './searchCoordinator'

describe('Sidekick Search coordinator', () => {
  it('returns partial results with diagnostics and caches successful searches', async () => {
    const duckduckgo: SearchSource = {
      id: 'duckduckgo',
      search: vi.fn(async () => [
        {
          title: 'Sidekick architecture',
          url: 'https://example.com/sidekick',
          description: 'Sidekick search architecture',
          source: 'duckduckgo' as const,
          rank: 1
        }
      ])
    }
    const brave: SearchSource = {
      id: 'brave',
      search: vi.fn(async () => {
        throw new Error('Source unavailable')
      })
    }
    const bing: SearchSource = { id: 'bing', search: vi.fn(async () => []) }
    const search = createSearchCoordinator([duckduckgo, brave, bing])

    const first = await search('  Sidekick   architecture  ', 5)
    const second = await search('Sidekick architecture', 5)

    expect(first).toMatchObject({ query: 'Sidekick architecture', cached: false })
    expect(first.results).toHaveLength(1)
    expect(first.diagnostics.map(({ source, status }) => [source, status])).toEqual([
      ['duckduckgo', 'ok'],
      ['brave', 'error'],
      ['bing', 'empty']
    ])
    expect(second.cached).toBe(true)
    expect(duckduckgo.search).toHaveBeenCalledTimes(1)
    expect(brave.search).toHaveBeenCalledTimes(1)
    expect(bing.search).toHaveBeenCalledTimes(1)
  })

  it('coalesces identical searches that are already in flight', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const source: SearchSource = {
      id: 'duckduckgo',
      search: vi.fn(async () => {
        await waiting
        return [
          {
            title: 'Result',
            url: 'https://example.com/result',
            description: 'query result',
            source: 'duckduckgo' as const,
            rank: 1
          }
        ]
      })
    }
    const search = createSearchCoordinator([source])

    const first = search('query')
    const second = search('query')
    release?.()
    await Promise.all([first, second])

    expect(source.search).toHaveBeenCalledTimes(1)
  })
})
