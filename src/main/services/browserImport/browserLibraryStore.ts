import type Database from 'better-sqlite3'
import type {
  BrowserBookmark,
  BrowserLibrarySource,
  BrowserSuggestion
} from '../../../shared/browserLibrary'
import type { ImportedBookmark, ImportedPage } from './importedData'

const MAX_QUERY = 200
const SUGGESTIONS = 6

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function folderOf(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.filter((part) => typeof part === 'string') : []
  } catch {
    return []
  }
}

/** The address without its scheme and `www.`, for matching what the user types. */
function bareAddress(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
}

/** Imported bookmarks and history in SideKick's database. */
export class BrowserLibraryStore {
  constructor(private readonly db: () => Database.Database) {}

  /**
   * Keeps what one import read, replacing what that source imported before for each kind that was
   * read. A kind the user left out of this import keeps what it had.
   */
  replace(
    source: { id: string; label: string },
    data: { bookmarks?: ImportedBookmark[]; history?: ImportedPage[] },
    now: number = Date.now()
  ): void {
    const db = this.db()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO browser_library_sources (id, label, imported_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, imported_at = excluded.imported_at`
      ).run(source.id, source.label, now)
      if (data.bookmarks) {
        db.prepare('DELETE FROM browser_library_bookmarks WHERE source_id = ?').run(source.id)
        const insert = db.prepare(
          `INSERT INTO browser_library_bookmarks (source_id, position, folder, title, url)
           VALUES (?, ?, ?, ?, ?)`
        )
        data.bookmarks.forEach((bookmark, position) =>
          insert.run(
            source.id,
            position,
            JSON.stringify(bookmark.folder),
            bookmark.title,
            bookmark.url
          )
        )
      }
      if (data.history) {
        db.prepare('DELETE FROM browser_library_history WHERE source_id = ?').run(source.id)
        const insert = db.prepare(
          `INSERT OR IGNORE INTO browser_library_history
             (source_id, url, title, visit_count, last_visit_at) VALUES (?, ?, ?, ?, ?)`
        )
        for (const page of data.history)
          insert.run(source.id, page.url, page.title, page.visitCount, page.lastVisitAt)
      }
      // A source left with nothing is not listed.
      db.prepare(
        `DELETE FROM browser_library_sources WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM browser_library_bookmarks WHERE source_id = ?)
           AND NOT EXISTS (SELECT 1 FROM browser_library_history WHERE source_id = ?)`
      ).run(source.id, source.id, source.id)
    })()
  }

  sources(): BrowserLibrarySource[] {
    return this.db()
      .prepare(
        `SELECT s.id AS id, s.label AS label, s.imported_at AS importedAt,
           (SELECT COUNT(*) FROM browser_library_bookmarks b WHERE b.source_id = s.id) AS bookmarks,
           (SELECT COUNT(*) FROM browser_library_history h WHERE h.source_id = s.id) AS history
         FROM browser_library_sources s ORDER BY s.imported_at DESC`
      )
      .all() as BrowserLibrarySource[]
  }

  bookmarks(): BrowserBookmark[] {
    const rows = this.db()
      .prepare(
        `SELECT b.source_id AS sourceId, b.folder AS folder, b.title AS title, b.url AS url
         FROM browser_library_bookmarks b JOIN browser_library_sources s ON s.id = b.source_id
         ORDER BY s.imported_at DESC, b.position`
      )
      .all() as Array<{ sourceId: string; folder: string; title: string; url: string }>
    return rows.map((row) => ({ ...row, folder: folderOf(row.folder) }))
  }

  /**
   * Pages matching what the user typed: bookmarks before history, an address that starts with the
   * text before one that merely contains it, then the most visited. Each address appears once.
   */
  suggest(query: string): BrowserSuggestion[] {
    const text = query.trim().toLowerCase().slice(0, MAX_QUERY)
    if (!text) return []
    const pattern = likePattern(text)
    const rows = this.db()
      .prepare(
        `SELECT url, title, 'bookmark' AS kind, 0 AS visits FROM (
           SELECT url, title FROM browser_library_bookmarks
           WHERE url LIKE @pattern ESCAPE '\\' OR title LIKE @pattern ESCAPE '\\' LIMIT 200
         )
         UNION ALL
         SELECT url, title, 'history' AS kind, visit_count AS visits FROM (
           SELECT url, title, visit_count FROM browser_library_history
           WHERE url LIKE @pattern ESCAPE '\\' OR title LIKE @pattern ESCAPE '\\'
           ORDER BY visit_count DESC LIMIT 200
         )`
      )
      .all({ pattern }) as Array<BrowserSuggestion & { visits: number }>
    // One entry per address: a bookmark keeps its own title, and visits come from history.
    const pages = new Map<
      string,
      { url: string; title: string; bookmark: boolean; visits: number }
    >()
    for (const row of rows) {
      const page = pages.get(row.url) ?? { url: row.url, title: '', bookmark: false, visits: 0 }
      if (row.kind === 'bookmark') {
        page.bookmark = true
        page.title = row.title || page.title
      } else {
        page.visits = Math.max(page.visits, row.visits)
        page.title ||= row.title
      }
      pages.set(row.url, page)
    }
    const score = (page: { url: string; bookmark: boolean; visits: number }): number =>
      (page.bookmark ? 2 : 0) +
      (bareAddress(page.url).toLowerCase().startsWith(text) ? 4 : 0) +
      Math.log10(1 + page.visits)
    return [...pages.values()]
      .sort((a, b) => score(b) - score(a))
      .slice(0, SUGGESTIONS)
      .map((page) => ({
        url: page.url,
        title: page.title,
        kind: page.bookmark ? ('bookmark' as const) : ('history' as const)
      }))
  }

  remove(sourceId?: string): void {
    const db = this.db()
    db.transaction(() => {
      for (const table of [
        'browser_library_bookmarks',
        'browser_library_history',
        'browser_library_sources'
      ]) {
        const column = table === 'browser_library_sources' ? 'id' : 'source_id'
        if (sourceId === undefined) db.prepare(`DELETE FROM ${table}`).run()
        else db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(sourceId)
      }
    })()
  }
}
