import type {
  BrowserBookmark,
  BrowserImportSource,
  BrowserLibraryAPI,
  BrowserLibrarySource,
  ImportBrowser
} from '../../../shared/browserLibrary'
import { IMPORT_BROWSER_NAMES } from '../../../shared/browserLibrary'

const PREVIEW_BROWSERS: BrowserImportSource[] = [
  {
    browser: 'chrome',
    name: IMPORT_BROWSER_NAMES.chrome,
    profiles: [
      { id: 'Default', name: 'Personal' },
      { id: 'Profile 1', name: 'Work' }
    ]
  },
  {
    browser: 'edge',
    name: IMPORT_BROWSER_NAMES.edge,
    profiles: [{ id: 'Default', name: 'Profile 1' }]
  },
  {
    browser: 'firefox',
    name: IMPORT_BROWSER_NAMES.firefox,
    profiles: [{ id: '0:Profile0', name: 'default-release' }]
  }
]

const PREVIEW_BOOKMARKS: Array<Omit<BrowserBookmark, 'sourceId'>> = [
  { folder: ['Bookmarks bar'], title: 'GitHub', url: 'https://github.com/' },
  { folder: ['Bookmarks bar'], title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
  {
    folder: ['Bookmarks bar', 'Docs'],
    title: 'Electron documentation',
    url: 'https://www.electronjs.org/docs/latest'
  },
  { folder: ['Bookmarks bar', 'Docs'], title: 'React', url: 'https://react.dev/' },
  { folder: ['Other bookmarks'], title: 'Hacker News', url: 'https://news.ycombinator.com/' }
]

/** Imported browser data for the renderer preview, kept in memory. */
export function previewBrowserLibraryApi(): BrowserLibraryAPI {
  let sources: BrowserLibrarySource[] = []
  let bookmarks: BrowserBookmark[] = []
  const label = (browser: ImportBrowser, profileId: string): string => {
    const source = PREVIEW_BROWSERS.find((entry) => entry.browser === browser)
    const profile = source?.profiles.find((entry) => entry.id === profileId)
    return `${IMPORT_BROWSER_NAMES[browser]} (${profile?.name ?? profileId})`
  }
  return {
    importSources: async () => PREVIEW_BROWSERS,
    previewImport: async (browser, profileId) => ({
      browser,
      profileId,
      label: label(browser, profileId),
      bookmarks: PREVIEW_BOOKMARKS.length,
      history: browser === 'firefox' ? 0 : 1_284,
      problems:
        browser === 'firefox'
          ? [
              {
                part: 'history',
                message: 'Firefox is using its history file. Quit Firefox and try again.'
              }
            ]
          : []
    }),
    runImport: async (request) => {
      const id = `${request.browser}:${request.profileId}`
      const name = label(request.browser, request.profileId)
      if (request.bookmarks) {
        bookmarks = [
          ...bookmarks.filter((bookmark) => bookmark.sourceId !== id),
          ...PREVIEW_BOOKMARKS.map((bookmark) => ({ ...bookmark, sourceId: id }))
        ]
      }
      sources = [
        {
          id,
          label: name,
          importedAt: Date.now(),
          bookmarks: request.bookmarks ? PREVIEW_BOOKMARKS.length : 0,
          history: request.history ? 1_284 : 0
        },
        ...sources.filter((source) => source.id !== id)
      ]
      return {
        label: name,
        bookmarks: request.bookmarks ? PREVIEW_BOOKMARKS.length : 0,
        history: request.history ? 1_284 : 0,
        problems: []
      }
    },
    importBookmarksFile: async () => null,
    sources: async () => sources,
    suggest: async (query) => {
      const text = query.trim().toLowerCase()
      if (!text) return []
      return bookmarks
        .filter((bookmark) => `${bookmark.url} ${bookmark.title}`.toLowerCase().includes(text))
        .slice(0, 6)
        .map((bookmark) => ({
          url: bookmark.url,
          title: bookmark.title,
          kind: 'bookmark' as const
        }))
    },
    remove: async (sourceId) => {
      sources = sourceId ? sources.filter((source) => source.id !== sourceId) : []
      bookmarks = sourceId ? bookmarks.filter((bookmark) => bookmark.sourceId !== sourceId) : []
      return sources
    }
  }
}
