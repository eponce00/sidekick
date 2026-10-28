import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openApplicationDatabase } from '../../bootstrap/database'
import { BrowserImportService } from './browserImportService'
import { BrowserLibraryStore } from './browserLibraryStore'
import { findProfiles, importSources, type ImportEnvironment } from './browserProfiles'
import {
  encodeBinaryPlist,
  writeChromiumHistory,
  writeFirefoxPlaces,
  writeSafariHistory
} from './fixtures'

const chromeBookmarks = (urls: string[]): string =>
  JSON.stringify({
    roots: {
      bookmark_bar: {
        type: 'folder',
        children: urls.map((url, index) => ({ type: 'url', name: `Bookmark ${index}`, url }))
      }
    }
  })

describe('browser import', () => {
  let home: string
  let env: ImportEnvironment
  let db: ReturnType<typeof openApplicationDatabase>
  let store: BrowserLibraryStore
  let service: BrowserImportService
  let chrome: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sidekick-import-test-'))
    env = {
      platform: 'win32',
      home,
      localAppData: join(home, 'Local'),
      appData: join(home, 'Roaming')
    }
    chrome = join(home, 'Local', 'Google', 'Chrome', 'User Data')
    for (const folder of ['Default', 'Profile 2', 'System Profile', 'Guest Profile', 'Crashpad'])
      mkdirSync(join(chrome, folder), { recursive: true })
    writeFileSync(
      join(chrome, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Personal', user_name: 'someone@example.com' },
            'Profile 2': { name: 'Work' },
            '../../Roaming': { name: 'Escape' }
          }
        }
      })
    )
    writeFileSync(
      join(chrome, 'Default', 'Bookmarks'),
      chromeBookmarks(['https://a.example/', 'https://b.example/'])
    )
    writeChromiumHistory(join(chrome, 'Default', 'History'), [
      { url: 'https://a.example/', title: 'A site', visits: 12 },
      { url: 'https://c.example/', title: 'C site', visits: 3 }
    ])
    writeFileSync(
      join(chrome, 'Profile 2', 'Bookmarks'),
      chromeBookmarks(['https://work.example/'])
    )
    // Chromium's own folders without a profile's files are not profiles.
    writeFileSync(
      join(chrome, 'Guest Profile', 'Bookmarks'),
      chromeBookmarks(['https://guest.example/'])
    )

    const firefox = join(home, 'Roaming', 'Mozilla', 'Firefox')
    mkdirSync(join(firefox, 'Profiles', 'abc.default-release'), { recursive: true })
    writeFileSync(
      join(firefox, 'profiles.ini'),
      '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n[Profile1]\nName=gone\nPath=Profiles/missing\n'
    )
    writeFirefoxPlaces(join(firefox, 'Profiles', 'abc.default-release', 'places.sqlite'), {
      bookmarks: [
        { id: 10, type: 1, parent: 3, position: 0, title: 'Fox', url: 'https://fox.example/' }
      ],
      history: [{ url: 'https://fox.example/', title: 'Fox', visits: 5 }]
    })

    db = openApplicationDatabase(':memory:')
    store = new BrowserLibraryStore(() => db)
    service = new BrowserImportService(store, { environment: env, tempRoot: home })
  })

  afterEach(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('lists browsers and profiles by name, never by folder', async () => {
    const sources = await service.sources()
    expect(sources).toEqual([
      {
        browser: 'chrome',
        name: 'Google Chrome',
        profiles: [
          { id: 'Default', name: 'Personal' },
          { id: 'Profile 2', name: 'Work' }
        ]
      },
      {
        browser: 'firefox',
        name: 'Firefox',
        profiles: [{ id: '0:Profile0', name: 'default-release' }]
      }
    ])
    expect(JSON.stringify(sources)).not.toContain(home)
  })

  it('previews what a profile holds without keeping anything', async () => {
    expect(await service.preview('chrome', 'Default')).toEqual({
      browser: 'chrome',
      profileId: 'Default',
      label: 'Google Chrome (Personal)',
      bookmarks: 2,
      history: 2,
      problems: []
    })
    expect(store.sources()).toEqual([])
  })

  it('imports the chosen parts, and a later import of one part keeps the other', async () => {
    const first = await service.run({
      browser: 'chrome',
      profileId: 'Default',
      bookmarks: true,
      history: true
    })
    expect(first).toEqual({
      label: 'Google Chrome (Personal)',
      bookmarks: 2,
      history: 2,
      problems: []
    })
    rmSync(join(chrome, 'Default', 'History'))
    writeChromiumHistory(join(chrome, 'Default', 'History'), [
      { url: 'https://only.example/', visits: 1 }
    ])
    await service.run({ browser: 'chrome', profileId: 'Default', bookmarks: false, history: true })
    expect(store.sources()).toMatchObject([{ id: 'chrome:Default', bookmarks: 2, history: 1 }])
    expect(store.bookmarks().map((bookmark) => bookmark.url)).toEqual([
      'https://a.example/',
      'https://b.example/'
    ])
  })

  it('reads Firefox bookmarks and history from one copy of places.sqlite', async () => {
    const result = await service.run({
      browser: 'firefox',
      profileId: '0:Profile0',
      bookmarks: true,
      history: true
    })
    expect(result).toMatchObject({ label: 'Firefox (default-release)', bookmarks: 1, history: 1 })
    expect(store.bookmarks()).toEqual([
      {
        sourceId: 'firefox:0:Profile0',
        folder: ['Bookmarks toolbar'],
        title: 'Fox',
        url: 'https://fox.example/'
      }
    ])
  })

  it.each([
    ['chrome', '../../Roaming'],
    ['chrome', 'Guest Profile'],
    ['chrome', 'System Profile'],
    ['chrome', join('..', '..', 'Local', 'Google', 'Chrome', 'User Data', 'Default')],
    ['firefox', '0:Profile1'],
    ['safari', 'default'],
    ['opera', 'Default'],
    ['chrome', { toString: () => 'Default' }],
    [undefined, undefined]
  ])('refuses browser %j profile %j, which it never offered', async (browser, profileId) => {
    await expect(service.preview(browser, profileId)).rejects.toThrow()
    await expect(
      service.run({ browser, profileId, bookmarks: true, history: true } as never)
    ).rejects.toThrow()
    expect(store.sources()).toEqual([])
  })

  it('reports a damaged part and still imports the rest', async () => {
    writeFileSync(join(chrome, 'Default', 'History'), 'not a database at all'.repeat(50))
    const result = await service.run({
      browser: 'chrome',
      profileId: 'Default',
      bookmarks: true,
      history: true
    })
    expect(result.bookmarks).toBe(2)
    expect(result.problems).toEqual([
      { part: 'history', message: "SideKick could not read this profile's history." }
    ])
  })

  it('treats a missing file as nothing to import', async () => {
    rmSync(join(chrome, 'Profile 2', 'Bookmarks'))
    writeChromiumHistory(join(chrome, 'Profile 2', 'History'), [])
    expect(await service.preview('chrome', 'Profile 2')).toMatchObject({
      bookmarks: 0,
      history: 0,
      problems: []
    })
  })

  it('needs at least one part', async () => {
    await expect(
      service.run({ browser: 'chrome', profileId: 'Default', bookmarks: false, history: false })
    ).rejects.toThrow(/Choose/)
  })

  it('imports an exported bookmarks file, replacing a file of the same name', async () => {
    const path = join(home, 'bookmarks.html')
    writeFileSync(
      path,
      '<DL><DT><A HREF="https://one.example/">One</A><DT><A HREF="https://two.example/">Two</A></DL>'
    )
    expect(await service.importFile(path)).toEqual({
      label: 'Bookmarks file bookmarks.html',
      bookmarks: 2,
      history: 0,
      problems: []
    })
    writeFileSync(path, '<DL><DT><A HREF="https://three.example/">Three</A></DL>')
    await service.importFile(path)
    expect(store.bookmarks().map((bookmark) => bookmark.title)).toEqual(['Three'])
  })

  it('finds Safari and the Chromium browsers in macOS folders', async () => {
    const mac = mkdtempSync(join(tmpdir(), 'sidekick-import-mac-'))
    try {
      const safari = join(mac, 'Library', 'Safari')
      mkdirSync(safari, { recursive: true })
      writeFileSync(
        join(safari, 'Bookmarks.plist'),
        encodeBinaryPlist({
          Children: [
            {
              WebBookmarkType: 'WebBookmarkTypeList',
              Title: 'BookmarksBar',
              Children: [
                {
                  WebBookmarkType: 'WebBookmarkTypeLeaf',
                  URLString: 'https://apple.com/',
                  URIDictionary: { title: 'Apple' }
                }
              ]
            }
          ]
        })
      )
      writeSafariHistory(join(safari, 'History.db'), [
        { url: 'https://apple.com/', titles: [{ title: 'Apple', at: Date.UTC(2026, 1, 1) }] }
      ])
      const arc = join(mac, 'Library', 'Application Support', 'Arc', 'User Data', 'Default')
      mkdirSync(arc, { recursive: true })
      writeChromiumHistory(join(arc, 'History'), [{ url: 'https://arc.example/' }])
      const macEnv: ImportEnvironment = { platform: 'darwin', home: mac }
      expect(importSources(await findProfiles(macEnv))).toEqual([
        { browser: 'arc', name: 'Arc', profiles: [{ id: 'Default', name: 'Default' }] },
        { browser: 'safari', name: 'Safari', profiles: [{ id: 'default', name: 'Safari' }] }
      ])
      const macService = new BrowserImportService(store, { environment: macEnv, tempRoot: mac })
      expect(await macService.preview('safari', 'default')).toMatchObject({
        label: 'Safari',
        bookmarks: 1,
        history: 1,
        problems: []
      })
    } finally {
      rmSync(mac, { recursive: true, force: true })
    }
  })
})
