import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_IMPORT_LIMITS } from '../../../shared/browserLibrary'
import {
  chromiumTime,
  parseChromiumBookmarks,
  parseChromiumLocalState,
  readChromiumHistory
} from './chromiumProfile'
import { writeChromiumHistory } from './fixtures'
import { readSqliteSnapshot } from './profileFiles'

const bookmarksFile = (roots: unknown): string =>
  JSON.stringify({ checksum: 'x', roots, version: 1 })

describe('parseChromiumBookmarks', () => {
  it('reads the three roots in order, with nested folders', () => {
    const bookmarks = parseChromiumBookmarks(
      bookmarksFile({
        bookmark_bar: {
          type: 'folder',
          children: [
            { type: 'url', name: 'GitHub', url: 'https://github.com/' },
            {
              type: 'folder',
              name: 'Docs',
              children: [{ type: 'url', name: 'MDN', url: 'https://developer.mozilla.org/' }]
            },
            { type: 'url', name: 'Last', url: 'https://last.example/' }
          ]
        },
        other: {
          type: 'folder',
          children: [{ type: 'url', name: 'HN', url: 'https://news.ycombinator.com/' }]
        },
        synced: {
          type: 'folder',
          children: [{ type: 'url', name: 'Phone', url: 'https://m.example/' }]
        }
      })
    )
    expect(bookmarks).toEqual([
      { folder: ['Bookmarks bar'], title: 'GitHub', url: 'https://github.com/' },
      { folder: ['Bookmarks bar', 'Docs'], title: 'MDN', url: 'https://developer.mozilla.org/' },
      { folder: ['Bookmarks bar'], title: 'Last', url: 'https://last.example/' },
      { folder: ['Other bookmarks'], title: 'HN', url: 'https://news.ycombinator.com/' },
      { folder: ['Mobile bookmarks'], title: 'Phone', url: 'https://m.example/' }
    ])
  })

  it('refuses a file that is not Chromium bookmarks', () => {
    expect(() => parseChromiumBookmarks('{not json')).toThrow()
    expect(() => parseChromiumBookmarks('[]')).toThrow()
    expect(() => parseChromiumBookmarks('{"roots": 5}')).toThrow()
  })

  it('skips nodes of the wrong shape and bookmarklets', () => {
    const bookmarks = parseChromiumBookmarks(
      bookmarksFile({
        bookmark_bar: {
          children: [
            null,
            7,
            'https://string.example/',
            { type: 'url', name: 'Bookmarklet', url: 'javascript:alert(1)' },
            { type: 'url', name: 'No url' },
            { type: 'folder', name: 'No children', children: 'nope' },
            { type: 'url', name: { evil: true }, url: 'https://ok.example/' }
          ]
        },
        other: 'nope'
      })
    )
    expect(bookmarks).toEqual([
      { folder: ['Bookmarks bar'], title: 'https://ok.example/', url: 'https://ok.example/' }
    ])
  })

  it('treats __proto__ and constructor as ordinary names', () => {
    const text = `{"roots":{"bookmark_bar":{"children":[{"type":"folder","name":"__proto__","children":[{"type":"url","name":"constructor","url":"https://p.example/"}]}]}}}`
    expect(parseChromiumBookmarks(text)).toEqual([
      { folder: ['Bookmarks bar', '__proto__'], title: 'constructor', url: 'https://p.example/' }
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('survives nesting far deeper than the stack, keeping only folders within the depth limit', () => {
    // Written as text: JSON.stringify would itself overflow at this depth. JSON.parse does not.
    const depth = 20_000
    const node =
      '{"type":"folder","name":"F","children":['.repeat(depth) +
      '{"type":"url","name":"Deep","url":"https://deep.example/"}' +
      ']}'.repeat(depth)
    const text = `{"roots":{"bookmark_bar":{"children":[${node},{"type":"url","name":"Shallow","url":"https://shallow.example/"}]}}}`
    const bookmarks = parseChromiumBookmarks(text)
    expect(bookmarks).toEqual([
      { folder: ['Bookmarks bar'], title: 'Shallow', url: 'https://shallow.example/' }
    ])
  })

  it('stops at the bookmark limit', () => {
    const children = Array.from({ length: BROWSER_IMPORT_LIMITS.bookmarks + 500 }, (_, index) => ({
      type: 'url',
      name: `B${index}`,
      url: `https://example.com/${index}`
    }))
    expect(parseChromiumBookmarks(bookmarksFile({ bookmark_bar: { children } }))).toHaveLength(
      BROWSER_IMPORT_LIMITS.bookmarks
    )
  })
})

describe('parseChromiumLocalState', () => {
  it('names profile folders, falling back to the folder name', () => {
    const names = parseChromiumLocalState(
      JSON.stringify({
        profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 3': { name: 5 } } }
      })
    )
    expect([...names]).toEqual([
      ['Default', 'Personal'],
      ['Profile 3', 'Profile 3']
    ])
    expect(parseChromiumLocalState('{}').size).toBe(0)
  })
})

describe('chromiumTime', () => {
  it('converts microseconds from 1601 and rejects implausible times', () => {
    const at = Date.UTC(2026, 0, 2)
    expect(chromiumTime((at + 11_644_473_600_000) * 1000)).toBe(at)
    expect(chromiumTime(0)).toBeNull()
    expect(chromiumTime(1)).toBeNull()
    expect(chromiumTime('x')).toBeNull()
    expect(chromiumTime(Number.MAX_SAFE_INTEGER * 1000)).toBeNull()
  })
})

describe('readChromiumHistory', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidekick-chromium-test-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('reads the most visited pages first and leaves out hidden ones', async () => {
    const path = join(directory, 'History')
    const at = Date.UTC(2026, 5, 1)
    writeChromiumHistory(path, [
      { url: 'https://rare.example/', title: 'Rare', visits: 1, lastVisit: at },
      { url: 'https://often.example/', title: 'Often', visits: 40, lastVisit: at },
      { url: 'https://hidden.example/', title: 'Hidden', visits: 99, hidden: 1 },
      { url: 'chrome://history/', title: 'Internal', visits: 50 },
      { url: 'https://user:pw@leak.example/', title: 'Leak', visits: 30 }
    ])
    const pages = await readSqliteSnapshot(path, readChromiumHistory, directory)
    expect(pages).toEqual([
      { url: 'https://often.example/', title: 'Often', visitCount: 40, lastVisitAt: at },
      { url: 'https://rare.example/', title: 'Rare', visitCount: 1, lastVisitAt: at }
    ])
  })

  it('refuses a urls view, which would run a query the file chose', async () => {
    const path = join(directory, 'History')
    const db = new Database(path)
    db.exec(`CREATE TABLE real(url TEXT, title TEXT, visit_count INT, last_visit_time INT, hidden INT);
      CREATE VIEW urls AS SELECT * FROM real`)
    db.close()
    await expect(readSqliteSnapshot(path, readChromiumHistory, directory)).rejects.toThrow(/urls/)
  })

  it('refuses a file that is not a database', async () => {
    const path = join(directory, 'History')
    const { writeFileSync } = await import('fs')
    writeFileSync(path, 'SQLite format 3\0 but not really'.repeat(100))
    await expect(readSqliteSnapshot(path, readChromiumHistory, directory)).rejects.toMatchObject({
      failure: 'unreadable'
    })
  })
})
