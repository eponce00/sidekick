import { browserIdentity } from './browserIdentity'

const SEARCH_TIMEOUT_MS = 9_000

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
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/html')) {
    throw new Error(`Unexpected content type: ${contentType || 'unknown'}`)
  }
  return await response.text()
}

export function normalizedText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}
