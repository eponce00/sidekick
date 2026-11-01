import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFirefoxPlaces } from './fixtures'
import { parseFirefoxProfilesIni, readFirefoxBookmarks, readFirefoxHistory } from './firefoxProfile'
import { readSqliteSnapshot } from './profileFiles'

describe('parseFirefoxProfilesIni', () => {
  const root = resolve('/home/me/.mozilla/firefox')

  it('resolves relative and absolute profiles, tolerating a BOM and CRLF', () => {
    const absolute = resolve('/data/firefox-work')
    const ini = [
      '﻿[General]',
      'StartWithLastProfile=1',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/abc.default-release',
      'Default=1',
      '',
      '[Profile1]',
      'Name=work',
      'IsRelative=0',
      `Path=${absolute}`,
      '',
      '[Install4F96D1932A9F858E]',
      'Default=Profiles/abc.default-release'
    ].join('\r\n')
    expect(parseFirefoxProfilesIni(ini, root)).toEqual([
      {
        id: 'Profile0',
        name: 'default-release',
        path: join(root, 'Profiles', 'abc.default-release')
      },
      { id: 'Profile1', name: 'work', path: absolute }
    ])
  })

  it('refuses a relative path that leaves the Firefox folder, and malformed sections', () => {
    const ini = [
      '[Profile0]',
      'Path=../../../../etc',
      '[Profile1]',
      'Path=Profiles/../../outside',
      '[Profile2]',
      'IsRelative=0',
      'Path=relative/but/marked/absolute',
      '[Profile3]',
      'Name=no path',
      '[NotAProfile]',
      'Path=Profiles/x',
      '[Profile4]',
      'Path=.'
    ].join('\n')
    expect(parseFirefoxProfilesIni(ini, root)).toEqual([])
  })
})

describe('places.sqlite', () => {
  let directory: string
  let places: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidekick-firefox-test-'))
    places = join(directory, 'places.sqlite')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('reads bookmarks under each root in position order, leaving out tags and separators', async () => {
    writeFirefoxPlaces(places, {
      bookmarks: [
        {
          id: 10,
          type: 1,
          parent: 3,
          position: 1,
          title: 'Second',
          url: 'https://second.example/'
        },
        { id: 11, type: 1, parent: 3, position: 0, title: 'First', url: 'https://first.example/' },
        { id: 12, type: 2, parent: 2, position: 0, title: 'Work' },
        {
          id: 13,
          type: 1,
          parent: 12,
          position: 0,
          title: 'Tracker',
          url: 'https://tracker.example/'
        },
        { id: 14, type: 3, parent: 2, position: 1 },
        { id: 15, type: 2, parent: 4, position: 0, title: 'a-tag' },
        {
          id: 16,
          type: 1,
          parent: 15,
          position: 0,
          title: 'Tagged',
          url: 'https://tagged.example/'
        },
        {
          id: 17,
          type: 1,
          parent: 5,
          position: 0,
          title: 'Smart',
          url: 'place:sort=8&maxResults=10'
        },
        { id: 18, type: 1, parent: 6, position: 0, title: 'Phone', url: 'https://phone.example/' }
      ]
    })
    const bookmarks = await readSqliteSnapshot(places, readFirefoxBookmarks, directory)
    expect(bookmarks).toEqual([
      { folder: ['Bookmarks toolbar'], title: 'First', url: 'https://first.example/' },
      { folder: ['Bookmarks toolbar'], title: 'Second', url: 'https://second.example/' },
      { folder: ['Bookmarks menu', 'Work'], title: 'Tracker', url: 'https://tracker.example/' },
      { folder: ['Mobile bookmarks'], title: 'Phone', url: 'https://phone.example/' }
    ])
  })

  it('ignores folders whose parents loop among themselves', async () => {
    writeFirefoxPlaces(places, {
      bookmarks: [
        { id: 20, type: 2, parent: 21, position: 0, title: 'A' },
        { id: 21, type: 2, parent: 20, position: 0, title: 'B' },
        { id: 22, type: 2, parent: 3, position: 0, title: 'Loop' },
        { id: 23, type: 2, parent: 22, position: 0, title: 'Inner' },
        { id: 24, type: 1, parent: 23, position: 0, title: 'Leaf', url: 'https://leaf.example/' }
      ]
    })
    const bookmarks = await readSqliteSnapshot(places, readFirefoxBookmarks, directory)
    expect(bookmarks).toEqual([
      {
        folder: ['Bookmarks toolbar', 'Loop', 'Inner'],
        title: 'Leaf',
        url: 'https://leaf.example/'
      }
    ])
  })

  it('reads nothing without Firefox roots', async () => {
    writeFirefoxPlaces(places, {
      roots: false,
      bookmarks: [{ id: 1, type: 1, parent: 0, position: 0, title: 'x', url: 'https://x.example/' }]
    })
    expect(await readSqliteSnapshot(places, readFirefoxBookmarks, directory)).toEqual([])
  })

  it('reads visited, visible pages most visited first', async () => {
    const at = Date.UTC(2026, 3, 4)
    writeFirefoxPlaces(places, {
      history: [
        { url: 'https://once.example/', title: 'Once', visits: 1, lastVisit: at },
        { url: 'https://daily.example/', title: 'Daily', visits: 70, lastVisit: at },
        { url: 'https://hidden.example/', visits: 90, hidden: 1 },
        { url: 'https://never.example/', visits: 0 }
      ]
    })
    expect(await readSqliteSnapshot(places, readFirefoxHistory, directory)).toEqual([
      { url: 'https://daily.example/', title: 'Daily', visitCount: 70, lastVisitAt: at },
      { url: 'https://once.example/', title: 'Once', visitCount: 1, lastVisitAt: at }
    ])
  })
})
