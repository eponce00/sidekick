import { Readability } from '@mozilla/readability'
import axios from 'axios'
import { BrowserWindow, session, type Session } from 'electron'
import { JSDOM } from 'jsdom'
import {
  loopbackHost,
  networkAddressKind,
  privateNetworkHost
} from '../../../shared/browserNetwork'
import {
  admitWebUrl,
  getAdmitted,
  resolveAdmitted,
  webNetworkRefusal,
  WebResponseLimit,
  type WebAdmission,
  type WebNetworkOptions
} from '../webNetworkGuard'
import { decodeWebText } from '../webResponseText'
import { browserIdentity } from './browserIdentity'
import { htmlToMarkdown } from './htmlMarkdown'
import type { PageContent } from './types'

const DIRECT_FETCH_TIMEOUT_MS = 18_000
const BROWSER_FETCH_TIMEOUT_MS = 25_000
const DEFAULT_MAX_CONTENT_LENGTH = 100_000
const RENDER_PARTITION = 'sidekick-page-reader'

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

function refusedPage(url: string, error: string): PageContent {
  return { ...emptyPage(url, error), refused: true }
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
  body: string,
  maxContentLength: number
): PageContent | null {
  const mediaType = contentType.split(';')[0].trim()
  if (!STRUCTURED_TEXT_TYPES.some((type) => mediaType.includes(type))) return null
  let text = body
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
  if (url.username || url.password) {
    throw new Error('Invalid page URL: it cannot carry a user name or password')
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

/** http(s) for ws(s), so a WebSocket answers to the same rules as the page that opens it. */
function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    return url
  } catch {
    return undefined
  }
}

/**
 * Whether a rendered page may make one request: never to this computer, and to the local network
 * only on `localOrigin`, the page's own origin when it was admitted there. Names are resolved and
 * checked first.
 */
export async function renderRequestAllowed(
  value: string,
  localOrigin: string | undefined,
  network: WebNetworkOptions = {}
): Promise<boolean> {
  if (/^(?:data|blob|about):/i.test(value)) return true
  const url = httpUrl(value)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
  if (url.username || url.password || loopbackHost(url.hostname)) return false
  const allowLocal = url.origin === localOrigin
  if (privateNetworkHost(url.hostname)) return allowLocal
  if (networkAddressKind(url.hostname)) return true
  try {
    await resolveAdmitted(url.hostname, { allowLocal }, network)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the address a rendered response came from was one its request could reach. Chromium
 * resolves the name again after the check above, so a name that rebinds in between shows here.
 */
export function renderResponseAllowed(
  value: string,
  ip: string | undefined,
  localOrigin: string | undefined,
  addressKind: (address: string) => ReturnType<typeof networkAddressKind> = networkAddressKind
): boolean {
  if (!ip) return true
  const kind = addressKind(ip)
  return kind === 'public' || (kind === 'local' && httpUrl(value)?.origin === localOrigin)
}

/** What one rendered read may reach, and why it was refused if it reached past that. */
interface RenderScope {
  localOrigin?: string
  network: WebNetworkOptions
  refused?: string
}

const renderScopes = new Map<number, RenderScope>()
let renderSession: Promise<Session> | undefined

/**
 * The rendered reads' own session: no permissions, so Chromium refuses a page's requests into the
 * local network, no downloads, direct connections so the address checked is the one reached,
 * and every request checked against the read it belongs to.
 */
function pageReaderSession(): Promise<Session> {
  renderSession ??= (async () => {
    const reader = session.fromPartition(RENDER_PARTITION)
    await reader.setProxy({ mode: 'direct' })
    reader.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    reader.setPermissionCheckHandler(() => false)
    reader.on('will-download', (event) => event.preventDefault())
    reader.webRequest.onBeforeRequest((details, callback) => {
      const scope = renderScopes.get(details.webContentsId ?? -1)
      void renderRequestAllowed(details.url, scope?.localOrigin, scope?.network)
        .catch(() => false)
        .then((allowed) => {
          if (!allowed && scope && details.resourceType === 'mainFrame') {
            scope.refused ??= `SideKick's network policy does not let web_fetch open ${details.url}`
          }
          callback({ cancel: !allowed })
        })
    })
    const watch = (details: { url: string; ip?: string; webContentsId?: number }): void => {
      const scope = renderScopes.get(details.webContentsId ?? -1)
      if (
        scope &&
        !renderResponseAllowed(
          details.url,
          details.ip,
          scope.localOrigin,
          scope.network.addressKind
        )
      ) {
        scope.refused ??= `${details.url} answered from ${details.ip}, an address web_fetch may not read`
      }
    }
    reader.webRequest.onBeforeRedirect(watch)
    reader.webRequest.onCompleted(watch)
    return reader
  })().catch((error: unknown) => {
    renderSession = undefined
    throw error
  })
  return renderSession
}

async function renderPage(
  url: string,
  maxContentLength: number,
  localOrigin: string | undefined,
  network: WebNetworkOptions
): Promise<PageContent> {
  let window: BrowserWindow | undefined
  let timeout: NodeJS.Timeout | undefined
  let contentsId: number | undefined
  const scope: RenderScope = { localOrigin, network }
  try {
    await pageReaderSession()
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: RENDER_PARTITION,
        javascript: true,
        nodeIntegration: false,
        contextIsolation: true,
        images: false,
        sandbox: true
      }
    })
    contentsId = window.webContents.id
    renderScopes.set(contentsId, scope)
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
          () =>
            reject(
              new Error(
                `The page did not finish loading within ${BROWSER_FETCH_TIMEOUT_MS / 1_000} seconds`
              )
            ),
          BROWSER_FETCH_TIMEOUT_MS
        )
      })
    ])
    // A page whose requests reached past its scope may hold what it read there.
    if (scope.refused) return refusedPage(url, scope.refused)
    return (
      readablePage(url, html, maxContentLength) || emptyPage(url, 'No readable page content found')
    )
  } catch (error) {
    if (scope.refused) return refusedPage(url, scope.refused)
    return emptyPage(url, error instanceof Error ? error.message : 'Rendered page failed')
  } finally {
    if (timeout) clearTimeout(timeout)
    if (contentsId !== undefined) renderScopes.delete(contentsId)
    if (window && !window.isDestroyed()) window.destroy()
  }
}

/**
 * Reads a page directly: its main article as Markdown (found with Firefox Readability), the
 * page's own details, and the text around the article.
 * JavaScript-heavy or protected pages are rendered once in Sidekick's embedded Chromium.
 * The browser's local-network rules apply to every request either makes, and the address of a
 * plain-HTTP device is read only once the user allows it through `network.policy`.
 */
export async function readPage(
  value: string,
  maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
  network: WebNetworkOptions = {}
): Promise<PageContent> {
  let url: URL
  try {
    url = validatedPageUrl(value)
  } catch (error) {
    return emptyPage(value, error instanceof Error ? error.message : 'Invalid page URL')
  }
  let admission: WebAdmission
  try {
    admission = await admitWebUrl(url, network)
  } catch (error) {
    return refusedPage(url.href, error instanceof Error ? error.message : 'The address was refused')
  }
  // A rendered page reaches the local network only on its own origin, and only if it is there.
  const localOrigin = admission.allowLocal ? url.origin : undefined

  const contentLimit = Math.max(1_000, Math.min(500_000, Math.trunc(maxContentLength)))
  try {
    const { response } = await getAdmitted<ArrayBuffer>(
      url,
      {
        timeout: DIRECT_FETCH_TIMEOUT_MS,
        // Bytes, decoded by the page's own charset: the HTTP client read all text as UTF-8.
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': browserIdentity(),
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          DNT: '1',
          Referer: url.origin
        }
      },
      network,
      admission
    )
    const contentType = String(response.headers['content-type'] || '').toLowerCase()
    const body = decodeWebText(Buffer.from(response.data), contentType)
    const structured = structuredTextPage(url, contentType, body, contentLimit)
    if (structured) return structured
    if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
      return emptyPage(url.href, `Unsupported page content type: ${contentType.split(';')[0]}`)
    }
    return (
      readablePage(url.href, body, contentLimit) ||
      renderPage(url.href, contentLimit, localOrigin, network)
    )
  } catch (error) {
    // A refused address is not a failure to render around, nor is a page too large to read.
    const refusal = webNetworkRefusal(error)
    if (refusal) return refusedPage(url.href, refusal.message)
    if (error instanceof WebResponseLimit) {
      // A slow server, or one that answers only browsers, may still load when rendered.
      return error.limit === 'time'
        ? renderPage(url.href, contentLimit, localOrigin, network)
        : emptyPage(url.href, error.message)
    }
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const message = error instanceof Error ? error.message : 'Page request failed'
    return shouldRenderInBrowser(status, message)
      ? renderPage(url.href, contentLimit, localOrigin, network)
      : emptyPage(url.href, message)
  }
}
