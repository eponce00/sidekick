import { JSDOM } from 'jsdom'
import type { SearchSource } from '../source'
import { fetchSearchDocument, normalizedText } from '../searchHttp'
import type { SourceSearchResult } from '../types'

export function parseBraveResults(html: string, limit: number): SourceSearchResult[] {
  const dom = new JSDOM(html, { url: 'https://search.brave.com/' })
  const document = dom.window.document
  if (document.title.toLowerCase().includes('captcha')) {
    dom.window.close()
    return []
  }

  const results = [
    ...document.querySelectorAll<HTMLAnchorElement>('#results .result-content > a[href]')
  ]
    .flatMap((anchor, index) => {
      const title = normalizedText(
        anchor.querySelector('.search-snippet-title')?.textContent || anchor.getAttribute('title')
      )
      const url = anchor.href
      const wrapper = anchor.closest('.result-wrapper')
      const description = normalizedText(
        wrapper?.querySelector('.generic-snippet .content')?.textContent
      )
      return title && /^https?:\/\//.test(url) && !new URL(url).hostname.endsWith('brave.com')
        ? [{ title, url, description, source: 'brave' as const, rank: index + 1 }]
        : []
    })
    .slice(0, limit)
  dom.window.close()
  return results
}

export const braveSource: SearchSource = {
  id: 'brave',
  async search(query, limit, signal) {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`
    return parseBraveResults(await fetchSearchDocument(url, signal), limit)
  }
}
