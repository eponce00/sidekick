import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'

/** A bookmark read from another browser, already checked. */
export interface ImportedBookmark {
  folder: string[]
  title: string
  url: string
}

/** A page from another browser's history, already checked. */
export interface ImportedPage {
  url: string
  title: string
  visitCount: number
  lastVisitAt: number | null
}

/**
 * The address to keep, or undefined. Only web pages are imported: `javascript:` bookmarklets,
 * `file:` paths and browser-internal pages mean nothing in SideKick's browser, and an address with
 * a username or password in it would copy that secret into SideKick in plain text.
 */
export function importableUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > BROWSER_IMPORT_LIMITS.urlLength) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password || !url.hostname) return undefined
  return url.href.length <= BROWSER_IMPORT_LIMITS.urlLength ? url.href : undefined
}

/** A title on one line, without control or direction-override characters, and not too long. */
export function importedTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, BROWSER_IMPORT_LIMITS.titleLength)
  )
}

/** A non-negative whole number, or 0. */
export function importedCount(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0
    ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER)
    : 0
}

/** Milliseconds since 1970, or null when the time is missing or implausible. */
export function plausibleTime(milliseconds: number): number | null {
  // Before 1995 or more than a day ahead is a broken clock or a broken file.
  return Number.isFinite(milliseconds) &&
    milliseconds > 788_918_400_000 &&
    milliseconds < Date.now() + 86_400_000
    ? Math.floor(milliseconds)
    : null
}

/** Collects bookmarks up to the limit, skipping ones that are not web pages. */
export class BookmarkCollector {
  readonly bookmarks: ImportedBookmark[] = []

  get full(): boolean {
    return this.bookmarks.length >= BROWSER_IMPORT_LIMITS.bookmarks
  }

  add(folder: string[], title: unknown, url: unknown): void {
    if (this.full) return
    const address = importableUrl(url)
    if (!address) return
    this.bookmarks.push({
      folder: folder.slice(0, BROWSER_IMPORT_LIMITS.folderDepth),
      title: importedTitle(title) || address,
      url: address
    })
  }
}

/** Keeps the first of each address, which callers order most visited first, up to the limit. */
export function collectPages(
  rows: Iterable<{ url: unknown; title: unknown; visits: unknown; lastVisitAt: number | null }>
): ImportedPage[] {
  const pages = new Map<string, ImportedPage>()
  for (const row of rows) {
    if (pages.size >= BROWSER_IMPORT_LIMITS.history) break
    const url = importableUrl(row.url)
    if (!url || pages.has(url)) continue
    pages.set(url, {
      url,
      title: importedTitle(row.title),
      visitCount: importedCount(row.visits),
      lastVisitAt: row.lastVisitAt
    })
  }
  return [...pages.values()]
}
