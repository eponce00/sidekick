import { Readability } from '@mozilla/readability'
import axios from 'axios'
import { BrowserWindow } from 'electron'
import { JSDOM } from 'jsdom'
import { browserIdentity } from './browserIdentity'
import { htmlToMarkdown } from './htmlMarkdown'
import type { PageContent } from './types'

const DIRECT_FETCH_TIMEOUT_MS = 18_000
const BROWSER_FETCH_TIMEOUT_MS = 25_000
const DEFAULT_MAX_CONTENT_LENGTH = 100_000

function emptyPage(url: string, error: string): PageContent {
  return {
    url,
    title: '',
    content: '',
    excerpt: '',
    byline: '',
    siteName: '',
    success: false,
    error
  }
}

const STRUCTURED_TEXT_TYPES = ['json', 'text/plain', 'text/csv', 'text/markdown']

/**
 * An API response or a plain-text file has no article for Readability to
 * extract, but it is exactly what was asked for. Refusing it pushed models to
 * fetch the data some other way and then claim they had read it.
 */
export function structuredTextPage(
  url: URL,
  contentType: string,
  body: unknown,
  maxContentLength: number
): PageContent | null {
  const mediaType = contentType.split(';')[0].trim()
  if (!STRUCTURED_TEXT_TYPES.some((type) => mediaType.includes(type))) return null
  let text = typeof body === 'string' ? body : JSON.stringify(body)
  if (mediaType.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Malformed JSON is still the server's answer; pass it through as text.
    }
  }
  const truncated = text.length > maxContentLength
  const content = truncated ? `${text.slice(0, maxContentLength)}\n… [truncated]` : text
  if (!content.trim()) return emptyPage(url.href, 'The response was empty')
  return {
    url: url.href,
    title: `${url.hostname}${url.pathname}`,
    content,
    excerpt: content.slice(0, 200),
    byline: '',
    siteName: url.hostname,
    success: true
  }
}

function validatedPageUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can be read')
  }
  return url
}

/** Page-level facts that sit outside any article: what it is, who wrote it, when it changed. */
export function pageDetails(document: Document): string[] {
  const meta = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = document
        .querySelector(`meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`)
        ?.getAttribute('content')
        ?.trim()
      if (value) return value
    }
    return undefined
  }
  const details: string[] = []
  const add = (label: string, value: unknown): void => {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
    if (!text) return
    const line = `${label}: ${text.length > 300 ? `${text.slice(0, 299)}…` : text}`
    if (!details.includes(line)) details.push(line)
  }
  add('Description', meta('description', 'og:description', 'twitter:description'))
  add('Author', meta('author', 'article:author'))
  add('Published', meta('article:published_time', 'datePublished', 'date', 'dc.date'))
  add('Updated', meta('article:modified_time', 'og:updated_time', 'dateModified', 'last-modified'))
  add('Type', meta('og:type'))
  add('Canonical', document.querySelector('link[rel="canonical"]')?.getAttribute('href'))

  // Structured data is where many sites state ratings, prices, versions and dates.
  const items: Record<string, unknown>[] = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (Array.isArray(record['@graph'])) collect(record['@graph'])
    if (record['@type']) items.push(record)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent ?? ''))
    } catch {
      // A malformed block is the site's problem; the rest of the page still reads.
    }
  }
  const nameOf = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(nameOf).filter(Boolean).join(', ')
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>).name
        : value
  for (const item of items.slice(0, 4)) {
    const type = [item['@type']].flat().join(', ')
    add(`${type} name`, item.name ?? item.headline)
    add(`${type} author`, nameOf(item.author))
    add(`${type} published`, item.datePublished)
    add(`${type} updated`, item.dateModified)
    add(`${type} version`, item.softwareVersion ?? item.version)
    const rating = item.aggregateRating as Record<string, unknown> | undefined
    if (rating?.ratingValue !== undefined) {
      const count = rating.ratingCount ?? rating.reviewCount
      add(
        `${type} rating`,
        `${rating.ratingValue}${count !== undefined ? ` (${count} ratings)` : ''}`
      )
    }
    const offer = [item.offers].flat()[0] as Record<string, unknown> | undefined
    if (offer?.price !== undefined) {
      add(`${type} price`, `${offer.price} ${offer.priceCurrency ?? ''}`)
    }
  }
  return details
}

const PAGE_CHROME = 'nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]'

function comparable(line: string): string {
  return line
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[#>*_`|[\]!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Text on the page outside its main article. Readability keeps only the article, so a sidebar's
 * facts were lost: a project's stars and last release, a product's price, a post's date.
 */
export function elsewhereOnPage(document: Document, url: string, article: string): string {
  const body = document.body?.cloneNode(true) as HTMLElement | undefined
  if (!body) return ''
  body.querySelectorAll(PAGE_CHROME).forEach((element) => element.remove())
  const seen = new Set(article.split('\n').map(comparable).filter(Boolean))
  const kept: string[] = []
  let fence: string | null = null
  for (const line of htmlToMarkdown(body, url).split('\n')) {
    // Code in the article is already there; code beside it is rarely what was asked for.
    const opener = line.match(/^(`{3,})/)?.[1]
    if (fence) {
      if (line.startsWith(fence)) fence = null
      continue
    }
    if (opener) {
      fence = opener
      continue
    }
    const key = comparable(line)
    if (!key) {
      if (kept.length && kept.at(-1) !== '') kept.push('')
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(line)
  }
  return kept.join('\n').trim()
}

export function readablePage(
  url: string,
  html: string,
  maxContentLength: number
): PageContent | undefined {
  const dom = new JSDOM(html, { url })
  try {
    const document = dom.window.document
    const details = pageDetails(document)
    // On a page with no single article, such as a front page, Readability takes the whole page,
    // menus included. The menus are never the content.
    const content = document.cloneNode(true) as Document
    content.querySelectorAll(PAGE_CHROME).forEach((element) => element.remove())
    const article = new Readability(content, { keepClasses: true }).parse()
    const main = article?.content
      ? htmlToMarkdown(JSDOM.fragment(article.content), url)
      : htmlToMarkdown(content.body ?? content, url)
    if (!main.trim()) return undefined
    const elsewhere = article?.content ? elsewhereOnPage(document, url, main) : ''

    const bound = (text: string, limit: number): string =>
      text.length > limit ? `${text.slice(0, limit)}\n\n[Content truncated...]` : text
    return {
      url,
      title: article?.title || document.title || '',
      content: bound(main, maxContentLength),
      excerpt: article?.excerpt || '',
      byline: article?.byline || '',
      siteName: article?.siteName || '',
      details,
      ...(elsewhere ? { elsewhere: bound(elsewhere, Math.floor(maxContentLength / 4)) } : {}),
      success: true
    }
  } finally {
    dom.window.close()
  }
}

function shouldRenderInBrowser(status?: number, message = ''): boolean {
  if (status === 401 || status === 403 || status === 406 || status === 408 || status === 409) {
    return true
  }
  if (status === 425 || status === 429 || (status !== undefined && status >= 500)) return true
  const normalized = message.toLowerCase()
  return ['timeout', 'socket hang up', 'econnreset', 'unexpected server response'].some((part) =>
    normalized.includes(part)
  )
}

async function renderPage(url: string, maxContentLength: number): Promise<PageContent> {
  let window: BrowserWindow | undefined
  let timeout: NodeJS.Timeout | undefined
  try {
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        javascript: true,
        nodeIntegration: false,
        contextIsolation: true,
        images: false,
        sandbox: true
      }
    })
    window.webContents.setAudioMuted(true)
    window.webContents.setUserAgent(browserIdentity())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const html = await Promise.race([
      (async () => {
        await window!.loadURL(url)
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return window!.webContents.executeJavaScript(
          'document.documentElement.outerHTML'
        ) as Promise<string>
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Rendered page timed out')),
          BROWSER_FETCH_TIMEOUT_MS
        )
      })
    ])
    return (
      readablePage(url, html, maxContentLength) || emptyPage(url, 'No readable page content found')
    )
  } catch (error) {
    return emptyPage(url, error instanceof Error ? error.message : 'Rendered page failed')
  } finally {
    if (timeout) clearTimeout(timeout)
    if (window && !window.isDestroyed()) window.destroy()
  }
}

/**
 * Reads a page directly: its main article as Markdown (found with Firefox Readability), the
 * page's own details, and the text around the article.
 * JavaScript-heavy or protected pages are rendered once in Sidekick's embedded Chromium.
 */
export async function readPage(
  value: string,
  maxContentLength = DEFAULT_MAX_CONTENT_LENGTH
): Promise<PageContent> {
  let url: URL
  try {
    url = validatedPageUrl(value)
  } catch (error) {
    return emptyPage(value, error instanceof Error ? error.message : 'Invalid page URL')
  }

  const contentLimit = Math.max(1_000, Math.min(500_000, Math.trunc(maxContentLength)))
  try {
    const response = await axios.get<string>(url.href, {
      timeout: DIRECT_FETCH_TIMEOUT_MS,
      responseType: 'text',
      maxRedirects: 5,
      headers: {
        'User-Agent': browserIdentity(),
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
        Referer: url.origin
      },
      validateStatus: (status) => status < 400
    })
    const contentType = String(response.headers['content-type'] || '').toLowerCase()
    const structured = structuredTextPage(url, contentType, response.data, contentLimit)
    if (structured) return structured
    if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
      return emptyPage(url.href, `Unsupported page content type: ${contentType.split(';')[0]}`)
    }
    return readablePage(url.href, response.data, contentLimit) || renderPage(url.href, contentLimit)
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const message = error instanceof Error ? error.message : 'Page request failed'
    return shouldRenderInBrowser(status, message)
      ? renderPage(url.href, contentLimit)
      : emptyPage(url.href, message)
  }
}
