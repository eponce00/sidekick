import type { SearchSourceId, SourceSearchResult } from './types'

export interface SearchSource {
  id: SearchSourceId
  search(query: string, limit: number, signal: AbortSignal): Promise<SourceSearchResult[]>
}

/** Whether `hostname` is `domain` or one of its subdomains, not merely a name ending in it. */
export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}
