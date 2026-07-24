import { JSDOM } from 'jsdom'
import type { SearchSource } from '../source'
import { fetchSearchDocument, normalizedText } from '../searchHttp'
import type { SourceSearchResult } from '../types'

function unwrapDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      return url.searchParams.get('uddg') || value
    }
    return url.toString()
  } catch {
    return value
  }
}

export function parseDuckDuckGoResults(html: string, limit: number): SourceSearchResult[] {
  const dom = new JSDOM(html, { url: 'https://html.duckduckgo.com/' })
  const results = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.result__a')]
    .flatMap((anchor, index) => {
      const title = normalizedText(anchor.textContent)
      const url = unwrapDuckDuckGoUrl(anchor.getAttribute('href') || '')
      const result = anchor.closest('.result')
      const description = normalizedText(result?.querySelector('.result__snippet')?.textContent)
      return title && /^https?:\/\//.test(url)
        ? [{ title, url, description, source: 'duckduckgo' as const, rank: index + 1 }]
        : []
    })
    .slice(0, limit)
  dom.window.close()
  return results
}

export const duckDuckGoSource: SearchSource = {
  id: 'duckduckgo',
  async search(query, limit, signal) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    return parseDuckDuckGoResults(await fetchSearchDocument(url, signal), limit)
  }
}
