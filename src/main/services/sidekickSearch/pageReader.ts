import { Readability } from '@mozilla/readability'
import axios from 'axios'
import { BrowserWindow } from 'electron'
import { JSDOM } from 'jsdom'
import { browserIdentity } from './browserIdentity'
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

function validatedPageUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can be read')
  }
  return url
}

function readablePage(
  url: string,
  html: string,
  maxContentLength: number
): PageContent | undefined {
  const dom = new JSDOM(html, { url })
  const article = new Readability(dom.window.document).parse()
  dom.window.close()
  if (!article) return undefined

  let content = article.textContent?.trim() || ''
  if (!content) return undefined
  if (content.length > maxContentLength) {
    content = `${content.slice(0, maxContentLength)}\n\n[Content truncated...]`
  }

  return {
    url,
    title: article.title || '',
    content,
    excerpt: article.excerpt || '',
    byline: article.byline || '',
    siteName: article.siteName || '',
    success: true
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
 * Reads a page directly and extracts its main text with Firefox Readability.
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
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
        Referer: url.origin
      },
      validateStatus: (status) => status < 400
    })
    const contentType = String(response.headers['content-type'] || '').toLowerCase()
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
