import { SearchCache } from './cache'
import { fuseSearchResults } from './fusion'
import type { SearchSource } from './source'
import { bingSource } from './sources/bing'
import { braveSource } from './sources/brave'
import { duckDuckGoSource } from './sources/duckDuckGo'
import type { SearchResponse, SearchSourceDiagnostic, SourceSearchResult } from './types'

function normalizedQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function createSearchCoordinator(
  sources: SearchSource[],
  cache = new SearchCache<SearchResponse>(5 * 60_000, 100)
): (query: string, requestedLimit?: number) => Promise<SearchResponse> {
  const pending = new Map<string, Promise<SearchResponse>>()

  return async (query: string, requestedLimit = 10): Promise<SearchResponse> => {
    const cleanQuery = normalizedQuery(query)
    if (!cleanQuery) throw new Error('Search query is required')
    const numericLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 10
    const limit = Math.max(1, Math.min(20, numericLimit))
    const cacheKey = `${cleanQuery.toLowerCase()}::${limit}`
    const cached = cache.get(cacheKey)
    if (cached) return { ...cached, cached: true }

    const activeSearch = pending.get(cacheKey)
    if (activeSearch) return activeSearch

    const search = (async (): Promise<SearchResponse> => {
      const controller = new AbortController()
      const searches = sources.map(async (source) => {
        const startedAt = Date.now()
        try {
          const results = await source.search(cleanQuery, Math.max(limit, 10), controller.signal)
          const diagnostic: SearchSourceDiagnostic = {
            source: source.id,
            status: results.length > 0 ? 'ok' : 'empty',
            resultCount: results.length,
            durationMs: Date.now() - startedAt
          }
          return { results, diagnostic }
        } catch (error) {
          const diagnostic: SearchSourceDiagnostic = {
            source: source.id,
            status: 'error',
            resultCount: 0,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message.slice(0, 160) : 'Search failed'
          }
          return { results: [] as SourceSearchResult[], diagnostic }
        }
      })

      const settled = await Promise.all(searches)
      const response: SearchResponse = {
        query: cleanQuery,
        results: fuseSearchResults(
          cleanQuery,
          settled.map((result) => result.results),
          limit
        ),
        diagnostics: settled.map((result) => result.diagnostic),
        cached: false
      }
      if (response.results.length > 0) cache.set(cacheKey, response)
      return response
    })().finally(() => pending.delete(cacheKey))

    pending.set(cacheKey, search)
    return search
  }
}

export const searchWeb = createSearchCoordinator([duckDuckGoSource, braveSource, bingSource])
