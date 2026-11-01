/**
 * Bookmarks and history the user imports from another browser on this computer, for the Browser
 * panel's address bar and bookmarks list. The main process reads the other browser's files; the
 * renderer only names a browser and a profile it was shown, and receives titles and addresses.
 * Sign-ins, cookies, and passwords are never read. The agent has no access to any of it.
 */

export const IMPORT_BROWSERS = [
  'chrome',
  'edge',
  'brave',
  'chromium',
  'arc',
  'firefox',
  'safari'
] as const
export type ImportBrowser = (typeof IMPORT_BROWSERS)[number]

export const IMPORT_BROWSER_NAMES: Record<ImportBrowser, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  chromium: 'Chromium',
  arc: 'Arc',
  firefox: 'Firefox',
  safari: 'Safari'
}

export interface BrowserImportProfile {
  /** An opaque name the main process resolves again; never a path. */
  id: string
  name: string
}

/** A browser installed on this computer, with the profiles it has. */
export interface BrowserImportSource {
  browser: ImportBrowser
  name: string
  profiles: BrowserImportProfile[]
}

/** Why one kind of data cannot be read from a profile, in words for the user. */
export interface BrowserImportProblem {
  part: 'bookmarks' | 'history'
  message: string
}

export interface BrowserImportPreview {
  browser: ImportBrowser
  profileId: string
  label: string
  bookmarks: number
  history: number
  problems: BrowserImportProblem[]
}

export interface BrowserImportRequest {
  browser: ImportBrowser
  profileId: string
  bookmarks: boolean
  history: boolean
}

export interface BrowserImportResult {
  label: string
  bookmarks: number
  history: number
  problems: BrowserImportProblem[]
}

/** The id an import from a browser profile is kept under, so importing it again replaces it. */
export function browserImportSourceId(browser: ImportBrowser, profileId: string): string {
  return `${browser}:${profileId}`
}

/** One import kept in SideKick; importing the same profile again replaces it. */
export interface BrowserLibrarySource {
  id: string
  label: string
  importedAt: number
  bookmarks: number
  history: number
}

export interface BrowserBookmark {
  sourceId: string
  /** Folder names from the top, such as `['Bookmarks bar', 'Work']`. */
  folder: string[]
  title: string
  url: string
}

export interface BrowserSuggestion {
  url: string
  title: string
  kind: 'bookmark' | 'history'
}

/** How many of each kind one import keeps: the most visited pages, and bookmarks in order. */
export const BROWSER_IMPORT_LIMITS = {
  bookmarks: 20_000,
  history: 20_000,
  urlLength: 2_048,
  titleLength: 300,
  folderDepth: 32
} as const

export interface BrowserLibraryAPI {
  /** Browsers and profiles found on this computer. */
  importSources: () => Promise<BrowserImportSource[]>
  /** The installed browser's own icon as a data URL, or null when the system has none for it. */
  browserIcon: (browser: ImportBrowser) => Promise<string | null>
  /** Counts what a profile holds, without keeping anything. */
  previewImport: (browser: ImportBrowser, profileId: string) => Promise<BrowserImportPreview>
  runImport: (request: BrowserImportRequest) => Promise<BrowserImportResult>
  /** Asks for a bookmarks file exported from any browser and imports it; null when cancelled. */
  importBookmarksFile: () => Promise<BrowserImportResult | null>
  sources: () => Promise<BrowserLibrarySource[]>
  suggest: (query: string) => Promise<BrowserSuggestion[]>
  /** Removes one import, or all of them when the id is omitted. */
  remove: (sourceId?: string) => Promise<BrowserLibrarySource[]>
}
