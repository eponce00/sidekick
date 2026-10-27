export type SearchSourceId = 'duckduckgo' | 'brave' | 'bing'

export interface SourceSearchResult {
  title: string
  url: string
  description: string
  source: SearchSourceId
  rank: number
}

export interface SearchResult {
  title: string
  url: string
  description: string
  sources: SearchSourceId[]
  score: number
}

export interface SearchSourceDiagnostic {
  source: SearchSourceId
  /** rate_limited: the engine refused with HTTP 429, and is skipped until retryAt. */
  status: 'ok' | 'empty' | 'error' | 'rate_limited'
  resultCount: number
  durationMs: number
  error?: string
  retryAt?: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  diagnostics: SearchSourceDiagnostic[]
  cached: boolean
}

export interface PageContent {
  url: string
  title: string
  content: string
  excerpt: string
  byline: string
  siteName: string
  /** Metadata and structured data: description, author, dates, ratings, prices. */
  details?: string[]
  /** Text outside the main article, without what the article already says. */
  elsewhere?: string
  success: boolean
  error?: string
  /** The local-network rules refused the address: a retry or a rendered read would not help. */
  refused?: boolean
}

export interface ImageSearchResult {
  title: string
  imageUrl: string
  thumbnailUrl: string
  pageUrl: string
  source: string
  resolution?: string
  mimeType?: string
  imageBase64?: string
}

export interface ImageSearchOptions {
  includeImageData?: boolean
  maxImagesWithData?: number
  maxBytesPerImage?: number
}
