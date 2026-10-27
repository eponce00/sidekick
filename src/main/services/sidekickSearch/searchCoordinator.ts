import { SearchCache } from './cache'
import { fuseSearchResults } from './fusion'
import { SearchHttpError } from './searchHttp'
import type { SearchSource } from './source'
import { bingSource } from './sources/bing'
import { braveSource } from './sources/brave'
import { duckDuckGoSource } from './sources/duckDuckGo'
import type {
  SearchResponse,
  SearchSourceDiagnostic,
  SearchSourceId,
  SourceSearchResult
} from './types'

/**
 * How long an engine that answered 429 is left alone. Asking again at once only extends the
 * limit; an agent once searched 55 times in a row against engines that kept refusing.
 */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000
const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000

function cooldownMs(error: SearchHttpError): number {
  const asked = error.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS
  return Math.max(60_000, Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, asked))
}

function normalizedQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function createSearchCoordinator(
  sources: SearchSource[],
  cache = new SearchCache<SearchResponse>(5 * 60_000, 100),
  now: () => number = Date.now
): (query: string, requestedLimit?: number) => Promise<SearchResponse> {
  const pending = new Map<string, Promise<SearchResponse>>()
  const rateLimitedUntil = new Map<SearchSourceId, number>()

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
        const startedAt = now()
        const retryAt = rateLimitedUntil.get(source.id)
        if (retryAt !== undefined && retryAt > startedAt) {
          const diagnostic: SearchSourceDiagnostic = {
            source: source.id,
            status: 'rate_limited',
            resultCount: 0,
            durationMs: 0,
            error: 'HTTP 429 (too many requests); not asked again yet',
            retryAt
          }
          return { results: [] as SourceSearchResult[], diagnostic }
        }
        try {
          const results = await source.search(cleanQuery, Math.max(limit, 10), controller.signal)
          rateLimitedUntil.delete(source.id)
          const diagnostic: SearchSourceDiagnostic = {
            source: source.id,
            status: results.length > 0 ? 'ok' : 'empty',
            resultCount: results.length,
            durationMs: now() - startedAt
          }
          return { results, diagnostic }
        } catch (error) {
          const limited = error instanceof SearchHttpError && error.status === 429
          const retryAt = limited ? now() + cooldownMs(error) : undefined
          if (retryAt !== undefined) rateLimitedUntil.set(source.id, retryAt)
          const diagnostic: SearchSourceDiagnostic = {
            source: source.id,
            status: limited ? 'rate_limited' : 'error',
            resultCount: 0,
            durationMs: now() - startedAt,
            error: error instanceof Error ? error.message.slice(0, 160) : 'Search failed',
            ...(retryAt !== undefined ? { retryAt } : {})
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
