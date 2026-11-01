import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBinaryPlist } from './binaryPlist'
import { encodeBinaryPlist, rawBinaryPlist, writeSafariHistory } from './fixtures'
import { readSqliteSnapshot } from './profileFiles'
import { parseSafariBookmarks, readSafariHistory } from './safariProfile'

const ref = (index: number): Buffer => Buffer.from([index >> 8, index & 255])
const ascii = (text: string): Buffer =>
  Buffer.concat([Buffer.from([0x50 | text.length]), Buffer.from(text, 'latin1')])

describe('parseBinaryPlist', () => {
  it('reads dictionaries, arrays, numbers, booleans and both kinds of string', () => {
    const value = { Title: 'Favorites', Count: 3, On: true, None: null, Names: ['a', 'Ünïcødé ✓'] }
    expect(parseBinaryPlist(encodeBinaryPlist(value))).toEqual(value)
  })

  it('makes dictionaries without a prototype, so __proto__ is only a key', () => {
    const parsed = parseBinaryPlist(
      encodeBinaryPlist({ ['__proto__']: 'x', constructor: 'y' })
    ) as Record<string, unknown>
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed.__proto__).toBe('x')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['another format', Buffer.from('<?xml version="1.0"?><plist></plist>'.padEnd(64))],
    ['a truncated file', encodeBinaryPlist({ a: 'b' }).subarray(0, 30)]
  ])('refuses %s', (_name, bytes) => {
    expect(() => parseBinaryPlist(bytes)).toThrow()
  })

  it('refuses a trailer whose counts or offsets point outside the file', () => {
    const good = encodeBinaryPlist(['x'])
    const lie = (at: number, value: bigint): Buffer => {
      const copy = Buffer.from(good)
      copy.writeBigUInt64BE(value, copy.length - 32 + at)
      return copy
    }
    expect(() => parseBinaryPlist(lie(8, 10n ** 12n))).toThrow(/object count/)
    expect(() => parseBinaryPlist(lie(16, 99n))).toThrow(/object count/)
    expect(() => parseBinaryPlist(lie(24, 2n ** 62n))).toThrow()
    const sizes = Buffer.from(good)
    sizes[sizes.length - 32 + 6] = 9
    expect(() => parseBinaryPlist(sizes)).toThrow(/integer sizes/)
  })

  it('refuses references, offsets, lengths and keys that do not fit the objects', () => {
    expect(() =>
      parseBinaryPlist(rawBinaryPlist([Buffer.concat([Buffer.from([0xa1]), ref(7)])]))
    ).toThrow(/reference/)
    const offsets = rawBinaryPlist([ascii('abc')])
    offsets.writeUInt32BE(0xffffff, offsets.length - 32 - 4)
    expect(() => parseBinaryPlist(offsets)).toThrow(/offset/)
    const long = Buffer.concat([
      Buffer.from([0x5f, 0x13]),
      Buffer.from([0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]),
      Buffer.from('ab')
    ])
    expect(() => parseBinaryPlist(rawBinaryPlist([long]))).toThrow(/past its end/)
    expect(() =>
      parseBinaryPlist(rawBinaryPlist([Buffer.concat([Buffer.from([0xa1]), ref(0)])]))
    ).toThrow(/loop/)
    const dict = Buffer.concat([Buffer.from([0xd1]), ref(1), ref(1)])
    expect(() => parseBinaryPlist(rawBinaryPlist([dict, Buffer.from([0x10, 0x05])]))).toThrow(/key/)
  })

  it('refuses nesting deeper than the limit', () => {
    const objects: Buffer[] = []
    for (let index = 0; index < 100; index++)
      objects.push(Buffer.concat([Buffer.from([0xa1]), ref(index + 1)]))
    objects.push(Buffer.from([0x00]))
    expect(() => parseBinaryPlist(rawBinaryPlist(objects))).toThrow(/deeply/)
  })

  it('reads each shared object once, so references cannot multiply the work', () => {
    // Every array holds the next one twice: walked as a tree that is 2^40 leaves.
    const objects: Buffer[] = []
    for (let index = 0; index < 40; index++)
      objects.push(Buffer.concat([Buffer.from([0xa2]), ref(index + 1), ref(index + 1)]))
    objects.push(Buffer.from([0x09]))
    const started = Date.now()
    const parsed = parseBinaryPlist(rawBinaryPlist(objects)) as unknown[]
    expect(Date.now() - started).toBeLessThan(1000)
    expect(parsed[0]).toBe(parsed[1])
  })
})

describe('parseSafariBookmarks', () => {
  const leaf = (title: string, url: string): Record<string, unknown> => ({
    WebBookmarkType: 'WebBookmarkTypeLeaf',
    URLString: url,
    URIDictionary: { title }
  })
  const list = (Title: string, Children: unknown[]): Record<string, unknown> => ({
    WebBookmarkType: 'WebBookmarkTypeList',
    Title,
    Children
  })

  it('names Safari’s own folders and keeps the rest', () => {
    const file = encodeBinaryPlist(
      list('', [
        { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History' },
        list('BookmarksBar', [
          leaf('Apple', 'https://www.apple.com/'),
          list('News', [leaf('BBC', 'https://bbc.co.uk/')])
        ]),
        list('BookmarksMenu', [leaf('Menu item', 'https://menu.example/')]),
        list('com.apple.ReadingList', [leaf('Later', 'https://later.example/')]),
        list('constructor', [leaf('Odd', 'https://odd.example/')]),
        leaf('Loose', 'https://loose.example/'),
        leaf('Script', 'javascript:void(0)')
      ]) as never
    )
    expect(parseSafariBookmarks(file)).toEqual([
      { folder: ['Favorites'], title: 'Apple', url: 'https://www.apple.com/' },
      { folder: ['Favorites', 'News'], title: 'BBC', url: 'https://bbc.co.uk/' },
      { folder: ['Bookmarks menu'], title: 'Menu item', url: 'https://menu.example/' },
      { folder: ['Reading list'], title: 'Later', url: 'https://later.example/' },
      { folder: ['constructor'], title: 'Odd', url: 'https://odd.example/' },
      { folder: ['Bookmarks'], title: 'Loose', url: 'https://loose.example/' }
    ])
  })

  it('refuses a property list that is not Safari bookmarks', () => {
    expect(() => parseSafariBookmarks(encodeBinaryPlist(['x']))).toThrow()
    expect(() => parseSafariBookmarks(encodeBinaryPlist({ Children: 'no' }))).toThrow()
  })
})

describe('readSafariHistory', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidekick-safari-test-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('takes each page’s latest title, most visited first', async () => {
    const path = join(directory, 'History.db')
    const early = Date.UTC(2026, 0, 1)
    const late = Date.UTC(2026, 6, 1)
    writeSafariHistory(path, [
      { url: 'https://once.example/', titles: [{ title: 'Once', at: late }] },
      {
        url: 'https://often.example/',
        visits: 12,
        titles: [
          { title: 'Old title', at: early },
          { title: 'New title', at: late }
        ]
      }
    ])
    expect(await readSqliteSnapshot(path, readSafariHistory, directory)).toEqual([
      { url: 'https://often.example/', title: 'New title', visitCount: 12, lastVisitAt: late },
      { url: 'https://once.example/', title: 'Once', visitCount: 1, lastVisitAt: late }
    ])
  })
})
