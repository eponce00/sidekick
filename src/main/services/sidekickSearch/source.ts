import type { SearchSourceId, SourceSearchResult } from './types'

export interface SearchSource {
  id: SearchSourceId
  search(query: string, limit: number, signal: AbortSignal): Promise<SourceSearchResult[]>
}
