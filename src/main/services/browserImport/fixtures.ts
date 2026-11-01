import Database from 'better-sqlite3'

/** Test fixtures in the browsers' own formats. Used only by tests. */

/** A Chromium `History` database with the columns Chromium writes. */
export function writeChromiumHistory(
  path: string,
  rows: Array<{ url: string; title?: string; visits?: number; lastVisit?: number; hidden?: 0 | 1 }>
): void {
  const db = new Database(path)
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`)
  const insert = db.prepare(
    'INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)'
  )
  for (const row of rows)
    insert.run(
      row.url,
      row.title ?? '',
      row.visits ?? 1,
      // Microseconds from 1601.
      row.lastVisit === undefined ? 0 : (row.lastVisit + 11_644_473_600_000) * 1000,
      row.hidden ?? 0
    )
  db.close()
}

export interface FirefoxFixtureBookmark {
  id: number
  type: 1 | 2 | 3
  parent: number
  position: number
  title?: string
  guid?: string
  url?: string
}

/** A Firefox `places.sqlite` with Firefox's roots and the given bookmarks and history. */
export function writeFirefoxPlaces(
  path: string,
  options: {
    bookmarks?: FirefoxFixtureBookmark[]
    history?: Array<{
      url: string
      title?: string
      visits?: number
      lastVisit?: number
      hidden?: 0 | 1
    }>
    roots?: boolean
  } = {}
): void {
  const db = new Database(path)
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR, guid TEXT)`)
  const place = db.prepare(
    'INSERT INTO moz_places (url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?)'
  )
  const placeFor = (url: string, title = '', visits = 0, lastVisit?: number, hidden = 0): number =>
    Number(
      place.run(url, title, visits, hidden, lastVisit === undefined ? null : lastVisit * 1000)
        .lastInsertRowid
    )
  for (const row of options.history ?? [])
    placeFor(row.url, row.title, row.visits ?? 1, row.lastVisit, row.hidden ?? 0)
  const bookmark = db.prepare(
    'INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  if (options.roots !== false) {
    bookmark.run(1, 2, null, 0, 0, '', 'root________')
    bookmark.run(2, 2, null, 1, 0, 'menu', 'menu________')
    bookmark.run(3, 2, null, 1, 1, 'toolbar', 'toolbar_____')
    bookmark.run(4, 2, null, 1, 2, 'tags', 'tags________')
    bookmark.run(5, 2, null, 1, 3, 'unfiled', 'unfiled_____')
    bookmark.run(6, 2, null, 1, 4, 'mobile', 'mobile______')
  }
  for (const row of options.bookmarks ?? []) {
    const fk = row.url ? placeFor(row.url) : null
    bookmark.run(
      row.id,
      row.type,
      fk,
      row.parent,
      row.position,
      row.title ?? null,
      row.guid ?? `guid-${row.id}`
    )
  }
  db.close()
}

/** A Safari `History.db` with one visit row per visit time given. */
export function writeSafariHistory(
  path: string,
  items: Array<{ url: string; visits?: number; titles: Array<{ title: string; at: number }> }>
): void {
  const db = new Database(path)
  db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE,
      visit_count INTEGER NOT NULL);
    CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL,
      visit_time REAL NOT NULL, title TEXT)`)
  const item = db.prepare('INSERT INTO history_items (url, visit_count) VALUES (?, ?)')
  const visit = db.prepare(
    'INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)'
  )
  for (const entry of items) {
    const id = item.run(entry.url, entry.visits ?? entry.titles.length).lastInsertRowid
    // Seconds from 2001-01-01.
    for (const { title, at } of entry.titles) visit.run(id, at / 1000 - 978_307_200, title)
  }
  db.close()
}

/**
 * A binary property list from raw objects, so tests can also write malformed ones. Each object is
 * its marker and payload; references inside it must already use `refSize` bytes.
 */
export function rawBinaryPlist(
  objects: Buffer[],
  options: { top?: number; refSize?: number; offsetSize?: number; count?: number } = {}
): Buffer {
  const offsetSize = options.offsetSize ?? 4
  const header = Buffer.from('bplist00', 'latin1')
  const offsets: number[] = []
  let position = header.length
  for (const object of objects) {
    offsets.push(position)
    position += object.length
  }
  const table = Buffer.alloc(objects.length * offsetSize)
  offsets.forEach((offset, index) => table.writeUIntBE(offset, index * offsetSize, offsetSize))
  const trailer = Buffer.alloc(32)
  trailer[6] = offsetSize
  trailer[7] = options.refSize ?? 2
  trailer.writeBigUInt64BE(BigInt(options.count ?? objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(options.top ?? 0), 16)
  trailer.writeBigUInt64BE(BigInt(position), 24)
  return Buffer.concat([header, ...objects, table, trailer])
}

type FixtureValue =
  | null
  | boolean
  | number
  | string
  | FixtureValue[]
  | { [key: string]: FixtureValue }

function marker(high: number, length: number): Buffer {
  if (length < 15) return Buffer.from([(high << 4) | length])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(length)
  return Buffer.concat([Buffer.from([(high << 4) | 0xf, 0x12]), size])
}

/** Encodes a value as a well-formed binary property list, with two-byte references. */
export function encodeBinaryPlist(value: FixtureValue): Buffer {
  const objects: Buffer[] = []
  const ref = (index: number): Buffer => {
    const bytes = Buffer.alloc(2)
    bytes.writeUInt16BE(index)
    return bytes
  }
  const add = (item: FixtureValue): number => {
    const index = objects.length
    objects.push(Buffer.alloc(0))
    if (item === null) objects[index] = Buffer.from([0x00])
    else if (typeof item === 'boolean') objects[index] = Buffer.from([item ? 0x09 : 0x08])
    else if (typeof item === 'number') {
      const bytes = Buffer.alloc(8)
      bytes.writeBigInt64BE(BigInt(item))
      objects[index] = Buffer.concat([Buffer.from([0x13]), bytes])
    } else if (typeof item === 'string') {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(item))
        objects[index] = Buffer.concat([marker(0x5, item.length), Buffer.from(item, 'latin1')])
      else {
        const units = Buffer.from(item, 'utf16le').swap16()
        objects[index] = Buffer.concat([marker(0x6, units.length / 2), units])
      }
    } else if (Array.isArray(item)) {
      const refs = item.map(add)
      objects[index] = Buffer.concat([marker(0xa, refs.length), ...refs.map(ref)])
    } else {
      const entries = Object.entries(item)
      const keys = entries.map(([key]) => add(key))
      const values = entries.map(([, entry]) => add(entry))
      objects[index] = Buffer.concat([
        marker(0xd, entries.length),
        ...keys.map(ref),
        ...values.map(ref)
      ])
    }
    return index
  }
  add(value)
  return rawBinaryPlist(objects, { refSize: 2 })
}
