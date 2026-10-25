import type Database from 'better-sqlite3'
import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import { parseBinaryPlist, type PlistValue } from './binaryPlist'
import {
  BookmarkCollector,
  collectPages,
  plausibleTime,
  type ImportedBookmark,
  type ImportedPage
} from './importedData'
import { requireTables } from './profileFiles'

/**
 * Safari keeps bookmarks in `~/Library/Safari/Bookmarks.plist`, a binary property list, and history
 * in `History.db`. macOS lets other apps read that folder only with Full Disk Access.
 */

const TOP_LEVEL: Record<string, string> = {
  BookmarksBar: 'Favorites',
  BookmarksMenu: 'Bookmarks menu',
  'com.apple.ReadingList': 'Reading list'
}

const MAX_NODES = 500_000

/** A dictionary from the property list, which the reader makes without a prototype. */
function dict(value: PlistValue | undefined): { [key: string]: PlistValue } | undefined {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === null
    ? (value as { [key: string]: PlistValue })
    : undefined
}

export function parseSafariBookmarks(bytes: Uint8Array): ImportedBookmark[] {
  const root = dict(parseBinaryPlist(bytes))
  if (!root || !Array.isArray(root.Children)) throw new Error('Not a Safari bookmarks file')
  const collector = new BookmarkCollector()
  const stack: Array<{ node: PlistValue; folder: string[] }> = []
  for (let index = root.Children.length - 1; index >= 0; index--)
    stack.push({ node: root.Children[index], folder: [] })
  let visited = 0
  while (stack.length && !collector.full && visited < MAX_NODES) {
    visited++
    const { node, folder } = stack.pop()!
    const entry = dict(node)
    if (!entry) continue
    if (entry.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      collector.add(
        folder.length ? folder : ['Bookmarks'],
        dict(entry.URIDictionary)?.title,
        entry.URLString
      )
    } else if (entry.WebBookmarkType === 'WebBookmarkTypeList' && Array.isArray(entry.Children)) {
      if (folder.length >= BROWSER_IMPORT_LIMITS.folderDepth) continue
      const title = typeof entry.Title === 'string' && entry.Title.trim() ? entry.Title : 'Folder'
      const name = !folder.length && Object.hasOwn(TOP_LEVEL, title) ? TOP_LEVEL[title] : title
      const inner = [...folder, name]
      for (let index = entry.Children.length - 1; index >= 0; index--)
        stack.push({ node: entry.Children[index], folder: inner })
    }
  }
  return collector.bookmarks
}

/** Safari counts seconds from 2001-01-01. */
function safariTime(value: unknown): number | null {
  const seconds = Number(value)
  return seconds > 0 ? plausibleTime((seconds + 978_307_200) * 1000) : null
}

/** Each page with the title of its latest visit, most visited first. */
export function readSafariHistory(db: Database.Database): ImportedPage[] {
  requireTables(db, ['history_items', 'history_visits'])
  const rows = db
    .prepare(
      `SELECT i.url AS url, i.visit_count AS visit_count, v.title AS title,
              MAX(v.visit_time) AS visit_time
       FROM history_items i JOIN history_visits v ON v.history_item = i.id
       WHERE i.url LIKE 'http%'
       GROUP BY i.id ORDER BY i.visit_count DESC, visit_time DESC LIMIT ?`
    )
    .iterate(BROWSER_IMPORT_LIMITS.history * 2) as Iterable<Record<string, unknown>>
  return collectPages(
    (function* () {
      for (const row of rows)
        yield {
          url: row.url,
          title: row.title,
          visits: row.visit_count,
          lastVisitAt: safariTime(row.visit_time)
        }
    })()
  )
}
