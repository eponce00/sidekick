import { browserIdentity } from './browserIdentity'

const SEARCH_TIMEOUT_MS = 9_000

/** A search engine answered with an HTTP error; a 429 may say when to come back. */
export class SearchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(status === 429 ? 'HTTP 429 (too many requests)' : `HTTP ${status}`)
  }
}

function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export async function fetchSearchDocument(
  url: string,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': browserIdentity(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
      ...extraHeaders
    },
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
  })
  if (!response.ok) {
    throw new SearchHttpError(response.status, retryAfterMs(response.headers.get('retry-after')))
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/html')) {
    throw new Error(`Unexpected content type: ${contentType || 'unknown'}`)
  }
  return await response.text()
}

export function normalizedText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}
