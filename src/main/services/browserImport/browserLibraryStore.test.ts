import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openApplicationDatabase } from '../../bootstrap/database'
import { BrowserLibraryStore } from './browserLibraryStore'

describe('BrowserLibraryStore', () => {
  let db: ReturnType<typeof openApplicationDatabase>
  let store: BrowserLibraryStore

  beforeEach(() => {
    db = openApplicationDatabase(':memory:')
    store = new BrowserLibraryStore(() => db)
    store.replace(
      { id: 'chrome:Default', label: 'Google Chrome (Personal)' },
      {
        bookmarks: [
          { folder: ['Bookmarks bar'], title: 'GitHub', url: 'https://github.com/' },
          {
            folder: ['Bookmarks bar', 'Docs'],
            title: '100% guide',
            url: 'https://percent.example/'
          }
        ],
        history: [
          { url: 'https://github.com/', title: 'GitHub', visitCount: 500, lastVisitAt: 1 },
          { url: 'https://www.gitlab.com/', title: 'GitLab', visitCount: 3, lastVisitAt: 1 },
          { url: 'https://example.com/git', title: 'About git', visitCount: 90, lastVisitAt: 1 },
          { url: 'https://news.example/', title: 'News', visitCount: 1000, lastVisitAt: 1 }
        ]
      },
      1_000
    )
  })
  afterEach(() => db.close())

  it('suggests bookmarks and addresses starting with the text first, each address once', () => {
    expect(store.suggest('git')).toEqual([
      { url: 'https://github.com/', title: 'GitHub', kind: 'bookmark' },
      { url: 'https://www.gitlab.com/', title: 'GitLab', kind: 'history' },
      { url: 'https://example.com/git', title: 'About git', kind: 'history' }
    ])
  })

  it('treats % and _ as text, not patterns', () => {
    expect(store.suggest('%').map((entry) => entry.url)).toEqual(['https://percent.example/'])
    expect(store.suggest('_')).toEqual([])
    expect(store.suggest('   ')).toEqual([])
  })

  it('lists sources with counts and bookmarks with their folders', () => {
    expect(store.sources()).toEqual([
      {
        id: 'chrome:Default',
        label: 'Google Chrome (Personal)',
        importedAt: 1_000,
        bookmarks: 2,
        history: 4
      }
    ])
    expect(store.bookmarks()[1]).toEqual({
      sourceId: 'chrome:Default',
      folder: ['Bookmarks bar', 'Docs'],
      title: '100% guide',
      url: 'https://percent.example/'
    })
  })

  it('drops a source that an import leaves empty', () => {
    store.replace({ id: 'chrome:Default', label: 'x' }, { bookmarks: [], history: [] })
    expect(store.sources()).toEqual([])
  })

  it('removes one source or all of them', () => {
    store.replace(
      { id: 'file:b.html', label: 'Bookmarks file b.html' },
      {
        bookmarks: [{ folder: ['Bookmarks'], title: 'B', url: 'https://b.example/' }]
      }
    )
    store.remove('chrome:Default')
    expect(store.sources().map((source) => source.id)).toEqual(['file:b.html'])
    expect(store.suggest('git')).toEqual([])
    store.remove()
    expect(store.sources()).toEqual([])
    expect(store.bookmarks()).toEqual([])
  })
})
