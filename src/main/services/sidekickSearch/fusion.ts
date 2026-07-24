import type { SearchResult, SourceSearchResult } from './types'

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'source'])

export function canonicalSearchUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key)
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    url.searchParams.sort()
    return url.toString()
  } catch {
    return undefined
  }
}

function queryTokens(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1)
  )
}

function lexicalBonus(query: Set<string>, result: SourceSearchResult): number {
  if (query.size === 0) return 0
  const haystack = `${result.title} ${result.description}`.toLowerCase()
  const matches = [...query].filter((token) => haystack.includes(token)).length
  return (matches / query.size) * 0.006
}

export function fuseSearchResults(
  query: string,
  sourceResults: SourceSearchResult[][],
  limit: number
): SearchResult[] {
  const tokens = queryTokens(query)
  const fused = new Map<string, SearchResult & { bestRank: number }>()

  for (const results of sourceResults) {
    for (const result of results) {
      const canonical = canonicalSearchUrl(result.url)
      if (!canonical) continue
      const contribution = 1 / (60 + result.rank) + lexicalBonus(tokens, result)
      const existing = fused.get(canonical)
      if (!existing) {
        fused.set(canonical, {
          title: result.title,
          url: canonical,
          description: result.description,
          sources: [result.source],
          score: contribution,
          bestRank: result.rank
        })
        continue
      }
      existing.score += contribution
      existing.bestRank = Math.min(existing.bestRank, result.rank)
      if (!existing.sources.includes(result.source)) {
        existing.sources.push(result.source)
        existing.score += 0.018
      }
      if (result.description.length > existing.description.length) {
        existing.description = result.description
      }
      if (result.title.length > existing.title.length && result.title.length < 180) {
        existing.title = result.title
      }
    }
  }

  const ranked = [...fused.values()].sort(
    (left, right) => right.score - left.score || left.bestRank - right.bestRank
  )
  const selected: typeof ranked = []
  const deferred: typeof ranked = []
  const domainCounts = new Map<string, number>()
  for (const result of ranked) {
    const domain = new URL(result.url).hostname
    const count = domainCounts.get(domain) || 0
    if (count >= 2) {
      deferred.push(result)
      continue
    }
    selected.push(result)
    domainCounts.set(domain, count + 1)
    if (selected.length >= limit) break
  }
  if (selected.length < limit) selected.push(...deferred.slice(0, limit - selected.length))

  return selected.slice(0, limit).map(({ bestRank: _bestRank, ...result }) => ({
    ...result,
    score: Number(result.score.toFixed(6))
  }))
}
