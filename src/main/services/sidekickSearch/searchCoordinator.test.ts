import { describe, expect, it, vi } from 'vitest'
import type { SearchSource } from './source'
import { createSearchCoordinator, RATE_LIMIT_COOLDOWN_MS } from './searchCoordinator'
import { SearchHttpError } from './searchHttp'

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

  it('leaves an engine that answered 429 alone until its cooldown passes', async () => {
    let clock = 0
    const limited: SearchSource = {
      id: 'brave',
      search: vi.fn(async () => {
        throw new SearchHttpError(429)
      })
    }
    const search = createSearchCoordinator([limited], undefined, () => clock)

    const first = await search('first')
    clock += RATE_LIMIT_COOLDOWN_MS - 1
    const skipped = await search('second')
    clock += 1
    await search('third')

    expect(first.diagnostics[0]).toMatchObject({
      status: 'rate_limited',
      retryAt: RATE_LIMIT_COOLDOWN_MS
    })
    expect(skipped.diagnostics[0].status).toBe('rate_limited')
    expect(limited.search).toHaveBeenCalledTimes(2)
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
