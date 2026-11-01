import type Database from 'better-sqlite3'
import { isAbsolute, relative, resolve } from 'path'
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
 * Firefox keeps a profile's bookmarks and history together in `places.sqlite`, and lists its
 * profiles in `profiles.ini`.
 * https://searchfox.org/firefox-main/source/toolkit/components/places/nsPlacesTables.h
 * https://support.mozilla.org/kb/profiles-where-firefox-stores-user-data
 */

export interface FirefoxProfileEntry {
  /** The section name, such as `Profile0`. */
  id: string
  name: string
  path: string
}

/** Firefox's own roots, by their fixed GUIDs. Tags are not bookmarks and are left out. */
const ROOTS: Array<[guid: string, label: string]> = [
  ['toolbar_____', 'Bookmarks toolbar'],
  ['menu________', 'Bookmarks menu'],
  ['unfiled_____', 'Other bookmarks'],
  ['mobile______', 'Mobile bookmarks']
]

const MAX_BOOKMARK_ROWS = 500_000

/**
 * The profiles `profiles.ini` lists, with their folders resolved. A relative path must stay inside
 * the folder that holds `profiles.ini`; Firefox writes absolute paths for profiles kept elsewhere.
 */
export function parseFirefoxProfilesIni(text: string, iniDirectory: string): FirefoxProfileEntry[] {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const raw of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const section = /^\[([^\]]{1,64})\]$/.exec(line)
    if (section) {
      current = new Map()
      sections.set(section[1], current)
      continue
    }
    const equals = line.indexOf('=')
    if (current && equals > 0)
      current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim())
  }
  const profiles: FirefoxProfileEntry[] = []
  for (const [id, values] of sections) {
    if (!/^Profile\d{1,4}$/.test(id)) continue
    const path = values.get('Path')
    if (!path) continue
    let folder: string
    if (values.get('IsRelative') === '0') {
      if (!isAbsolute(path)) continue
      folder = resolve(path)
    } else {
      folder = resolve(iniDirectory, path)
      const inside = relative(resolve(iniDirectory), folder)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
    }
    profiles.push({ id, name: values.get('Name')?.trim() || id, path: folder })
  }
  return profiles
}

/** Firefox counts microseconds from 1970. */
function firefoxTime(value: unknown): number | null {
  const micros = typeof value === 'bigint' ? Number(value) : Number(value)
  return micros > 0 ? plausibleTime(micros / 1000) : null
}

export function readFirefoxHistory(db: Database.Database): ImportedPage[] {
  requireTables(db, ['moz_places'])
  const rows = db
    .prepare(
      `SELECT url, title, visit_count, last_visit_date FROM moz_places
       WHERE hidden = 0 AND visit_count > 0 AND url LIKE 'http%'
       ORDER BY visit_count DESC, last_visit_date DESC LIMIT ?`
    )
    .iterate(BROWSER_IMPORT_LIMITS.history * 2) as Iterable<Record<string, unknown>>
  return collectPages(
    (function* () {
      for (const row of rows)
        yield {
          url: row.url,
          title: row.title,
          visits: row.visit_count,
          lastVisitAt: firefoxTime(row.last_visit_date)
        }
    })()
  )
}

interface BookmarkRow {
  id: number
  type: number
  parent: number
  position: number
  title: unknown
  guid: unknown
  url: unknown
}

/** Bookmarks under Firefox's roots, each folder in its own order. */
export function readFirefoxBookmarks(db: Database.Database): ImportedBookmark[] {
  requireTables(db, ['moz_bookmarks', 'moz_places'])
  const rows = db
    .prepare(
      `SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position,
              b.title AS title, b.guid AS guid, p.url AS url
       FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
       LIMIT ?`
    )
    .all(MAX_BOOKMARK_ROWS) as BookmarkRow[]
  const children = new Map<number, BookmarkRow[]>()
  for (const row of rows) {
    const list = children.get(row.parent)
    if (list) list.push(row)
    else children.set(row.parent, [row])
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)
  const collector = new BookmarkCollector()
  // Each folder is entered once, so a parent loop in a damaged file cannot repeat forever.
  const entered = new Set<number>()
  for (const [guid, label] of ROOTS) {
    const root = rows.find((row) => row.guid === guid && row.type === 2)
    if (!root || entered.has(root.id)) continue
    entered.add(root.id)
    const stack: Array<{ row: BookmarkRow; folder: string[] }> = []
    const push = (parent: number, folder: string[]): void => {
      const list = children.get(parent) ?? []
      for (let index = list.length - 1; index >= 0; index--)
        stack.push({ row: list[index], folder })
    }
    push(root.id, [label])
    while (stack.length && !collector.full) {
      const { row, folder } = stack.pop()!
      if (row.type === 1) {
        collector.add(folder, row.title, row.url)
      } else if (row.type === 2 && !entered.has(row.id)) {
        entered.add(row.id)
        if (folder.length >= BROWSER_IMPORT_LIMITS.folderDepth) continue
        const name = typeof row.title === 'string' && row.title.trim() ? row.title : 'Folder'
        push(row.id, [...folder, name])
      }
    }
  }
  return collector.bookmarks
}
