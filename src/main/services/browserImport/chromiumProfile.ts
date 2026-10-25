import type Database from 'better-sqlite3'
import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import {
  BookmarkCollector,
  collectPages,
  plausibleTime,
  type ImportedBookmark,
  type ImportedPage
} from './importedData'
import { requireTables } from './profileFiles'

/**
 * Chrome, Edge, Brave, Chromium, and Arc keep each profile's bookmarks in a JSON file named
 * `Bookmarks` and its history in a SQLite database named `History`.
 * https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
 */

const ROOTS: Array<[key: string, label: string]> = [
  ['bookmark_bar', 'Bookmarks bar'],
  ['other', 'Other bookmarks'],
  ['synced', 'Mobile bookmarks']
]

/** Nodes visited before giving up on a file, however it nests. */
const MAX_NODES = 500_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Reads a `Bookmarks` file's three roots in the browser's order. */
export function parseChromiumBookmarks(text: string): ImportedBookmark[] {
  const roots = record(record(JSON.parse(text))?.roots)
  if (!roots) throw new Error('Not a Chromium bookmarks file')
  const collector = new BookmarkCollector()
  let visited = 0
  for (const [key, label] of ROOTS) {
    // Depth-first in the file's order, without recursion, so deep nesting cannot overflow the stack.
    const stack: Array<{ node: unknown; folder: string[] }> = []
    const root = record(roots[key])
    if (Array.isArray(root?.children)) {
      for (let index = root.children.length - 1; index >= 0; index--)
        stack.push({ node: root.children[index], folder: [label] })
    }
    while (stack.length && !collector.full && visited < MAX_NODES) {
      visited++
      const { node, folder } = stack.pop()!
      const entry = record(node)
      if (!entry) continue
      if (entry.type === 'url') {
        collector.add(folder, entry.name, entry.url)
      } else if (entry.type === 'folder' && Array.isArray(entry.children)) {
        if (folder.length >= BROWSER_IMPORT_LIMITS.folderDepth) continue
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : 'Folder'
        const inner = [...folder, name]
        for (let index = entry.children.length - 1; index >= 0; index--)
          stack.push({ node: entry.children[index], folder: inner })
      }
    }
  }
  return collector.bookmarks
}

/** Chromium counts microseconds from 1601, as Windows does. */
export function chromiumTime(value: unknown): number | null {
  const micros = typeof value === 'bigint' ? Number(value) : Number(value)
  return micros > 0 ? plausibleTime(micros / 1000 - 11_644_473_600_000) : null
}

/** The most visited pages first, without pages the browser hides from its own history list. */
export function readChromiumHistory(db: Database.Database): ImportedPage[] {
  requireTables(db, ['urls'])
  const rows = db
    .prepare(
      `SELECT url, title, visit_count, last_visit_time FROM urls
       WHERE hidden = 0 AND url LIKE 'http%'
       ORDER BY visit_count DESC, last_visit_time DESC LIMIT ?`
    )
    .iterate(BROWSER_IMPORT_LIMITS.history * 2) as Iterable<Record<string, unknown>>
  return collectPages(
    (function* () {
      for (const row of rows)
        yield {
          url: row.url,
          title: row.title,
          visits: row.visit_count,
          lastVisitAt: chromiumTime(row.last_visit_time)
        }
    })()
  )
}

/** Profile folder names and their display names, from the browser's `Local State` file. */
export function parseChromiumLocalState(text: string): Map<string, string> {
  const profiles = new Map<string, string>()
  const cache = record(record(record(JSON.parse(text))?.profile)?.info_cache)
  if (!cache) return profiles
  for (const [folder, info] of Object.entries(cache)) {
    const name = record(info)?.name
    profiles.set(folder, typeof name === 'string' && name.trim() ? name.trim() : folder)
  }
  return profiles
}
