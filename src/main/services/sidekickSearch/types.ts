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
  status: 'ok' | 'empty' | 'error'
  resultCount: number
  durationMs: number
  error?: string
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
  success: boolean
  error?: string
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
