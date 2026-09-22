import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Resolves a site's own icon for links shown in replies.
 *
 * Only the linked site is ever contacted — never a third-party icon service —
 * so showing an icon discloses no more than clicking the link would, which is
 * the line PRIVACY.md draws. Results, including misses, are cached on disk so
 * a host is asked at most once per week.
 */
const ICON_TIMEOUT_MS = 4_000
const MAX_ICON_BYTES = 256 * 1024
const MAX_HTML_BYTES = 200 * 1024
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif'
])

interface CachedIcon {
  dataUrl: string | null
  fetchedAt: number
}

export class SiteIconService {
  private readonly memory = new Map<string, Promise<string | null>>()
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly cacheDir: string,
    fetchImpl: typeof fetch = fetch
  ) {
    this.fetchImpl = fetchImpl
  }

  /** Data URL for the site's icon, or null when it has none we can use. */
  async iconFor(origin: string): Promise<string | null> {
    const host = SiteIconService.hostFor(origin)
    if (!host) return null
    let pending = this.memory.get(host)
    if (!pending) {
      pending = this.load(host).catch(() => null)
      this.memory.set(host, pending)
    }
    return pending
  }

  static hostFor(value: string): string | null {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      // Local and private hosts are never contacted for decoration.
      if (/^(localhost|127\.|10\.|192\.168\.|\[::1\]|0\.0\.0\.0)/i.test(url.hostname)) return null
      return `${url.protocol}//${url.host}`
    } catch {
      return null
    }
  }

  private cachePath(host: string): string {
    const safe = host.replace(/[^a-z0-9.-]/gi, '_')
    return join(this.cacheDir, `${safe}.json`)
  }

  private async load(host: string): Promise<string | null> {
    const cached = await this.readCache(host)
    if (cached) return cached.dataUrl
    const dataUrl =
      (await this.fetchIcon(`${host}/favicon.ico`)) ?? (await this.fetchDeclaredIcon(host))
    await this.writeCache(host, dataUrl)
    return dataUrl
  }

  private async readCache(host: string): Promise<CachedIcon | null> {
    try {
      const raw = await fs.readFile(this.cachePath(host), 'utf8')
      const parsed = JSON.parse(raw) as CachedIcon
      if (typeof parsed.fetchedAt !== 'number' || Date.now() - parsed.fetchedAt > CACHE_TTL_MS)
        return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeCache(host: string, dataUrl: string | null): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      const entry: CachedIcon = { dataUrl, fetchedAt: Date.now() }
      await fs.writeFile(this.cachePath(host), JSON.stringify(entry), 'utf8')
    } catch {
      // A cache miss just means one more request next time.
    }
  }

  private async fetchIcon(url: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
        redirect: 'follow',
        headers: { accept: 'image/*' }
      })
      if (!response.ok) return null
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!ICON_TYPES.has(type)) return null
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length > MAX_ICON_BYTES) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_ICON_BYTES) return null
      return `data:${type};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  /** Many sites declare their icon in the page head instead of at /favicon.ico. */
  private async fetchDeclaredIcon(host: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${host}/`, {
        signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
        redirect: 'follow',
        headers: { accept: 'text/html' }
      })
      if (!response.ok) return null
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        total += value.length
      }
      void reader.cancel().catch(() => undefined)
      const html = Buffer.concat(chunks).toString('utf8')
      const href = SiteIconService.declaredIconHref(html)
      if (!href) return null
      return this.fetchIcon(new URL(href, `${host}/`).toString())
    } catch {
      return null
    }
  }

  /** First <link rel="…icon…" href="…"> in the document head, if any. */
  static declaredIconHref(html: string): string | null {
    const head = html.slice(
      0,
      html.search(/<body[\s>]/i) === -1 ? html.length : html.search(/<body[\s>]/i)
    )
    for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
      const tag = match[0]
      const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? ''
      if (!/\bicon\b/.test(rel) || /mask-icon/.test(rel)) continue
      const href = /\bhref\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]
      if (href) return href
    }
    return null
  }
}
