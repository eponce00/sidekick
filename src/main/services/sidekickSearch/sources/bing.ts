import { JSDOM } from 'jsdom'
import type { SearchSource } from '../source'
import { fetchSearchDocument, normalizedText } from '../searchHttp'
import type { SourceSearchResult } from '../types'

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

function unwrapBingUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!url.hostname.endsWith('bing.com') || url.pathname !== '/ck/a') return url.toString()
    const wrapped = url.searchParams.get('u')
    if (!wrapped?.startsWith('a1')) return value
    const decoded = decodeBase64Url(wrapped.slice(2))
    return decoded && /^https?:\/\//.test(decoded) ? decoded : value
  } catch {
    return value
  }
}

export function parseBingResults(html: string, limit: number): SourceSearchResult[] {
  const dom = new JSDOM(html, { url: 'https://www.bing.com/' })
  const results = [...dom.window.document.querySelectorAll<HTMLLIElement>('#b_results > li.b_algo')]
    .flatMap((item, index) => {
      const anchor = item.querySelector<HTMLAnchorElement>('h2 a[href]')
      const title = normalizedText(anchor?.textContent)
      const url = unwrapBingUrl(anchor?.href || '')
      const description = normalizedText(item.querySelector('.b_caption p')?.textContent)
      return title && /^https?:\/\//.test(url)
        ? [{ title, url, description, source: 'bing' as const, rank: index + 1 }]
        : []
    })
    .slice(0, limit)
  dom.window.close()
  return results
}

export const bingSource: SearchSource = {
  id: 'bing',
  async search(query, limit, signal) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`
    return parseBingResults(await fetchSearchDocument(url, signal), limit)
  }
}
