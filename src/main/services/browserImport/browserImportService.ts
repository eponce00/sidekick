import { basename, join } from 'path'
import {
  IMPORT_BROWSER_NAMES,
  IMPORT_BROWSERS,
  type BrowserImportPreview,
  type BrowserImportProblem,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSource,
  type ImportBrowser
} from '../../../shared/browserLibrary'
import type { BrowserLibraryStore } from './browserLibraryStore'
import { parseBookmarksFile } from './bookmarksFile'
import {
  currentImportEnvironment,
  findProfiles,
  importSources,
  type FoundProfile,
  type ImportEnvironment
} from './browserProfiles'
import { parseChromiumBookmarks, readChromiumHistory } from './chromiumProfile'
import { readFirefoxBookmarks, readFirefoxHistory } from './firefoxProfile'
import type { ImportedBookmark, ImportedPage } from './importedData'
import { ProfileFileError, readProfileFile, readSqliteSnapshot } from './profileFiles'
import { parseSafariBookmarks, readSafariHistory } from './safariProfile'

const MAX_BOOKMARKS_FILE_BYTES = 64 * 1024 * 1024
const MAX_EXPORTED_FILE_BYTES = 32 * 1024 * 1024

type Part = BrowserImportProblem['part']

interface ProfileData {
  bookmarks?: ImportedBookmark[]
  history?: ImportedPage[]
  problems: BrowserImportProblem[]
}

function problem(part: Part, error: unknown, profile: FoundProfile): BrowserImportProblem {
  const browser = IMPORT_BROWSER_NAMES[profile.browser]
  const failure = error instanceof ProfileFileError ? error.failure : 'unreadable'
  if (failure === 'permission' && profile.browser === 'safari')
    return {
      part,
      message:
        "macOS shows Safari's data only to apps with Full Disk Access. You can export your bookmarks from Safari (File › Export › Bookmarks) and import that file instead."
    }
  if (failure === 'permission')
    return { part, message: `SideKick is not allowed to read ${browser}'s ${part}.` }
  if (failure === 'locked')
    return { part, message: `${browser} is using its ${part} file. Quit ${browser} and try again.` }
  if (failure === 'too_large')
    return { part, message: `This profile's ${part} file is too large to import.` }
  return { part, message: `SideKick could not read this profile's ${part}.` }
}

/** Bookmarks and history read from one profile, each kind read only when asked for. */
async function readProfile(
  profile: FoundProfile,
  parts: { bookmarks: boolean; history: boolean },
  tempRoot: string | undefined
): Promise<ProfileData> {
  const data: ProfileData = { problems: [] }
  const attempt = async <T>(
    part: Part,
    read: () => Promise<T | undefined>
  ): Promise<T | undefined> => {
    try {
      return await read()
    } catch (error) {
      data.problems.push(problem(part, error, profile))
      return undefined
    }
  }
  const directory = profile.directory
  if (profile.kind === 'chromium') {
    if (parts.bookmarks)
      data.bookmarks = await attempt('bookmarks', async () => {
        const bytes = await readProfileFile(join(directory, 'Bookmarks'), MAX_BOOKMARKS_FILE_BYTES)
        return bytes ? parseChromiumBookmarks(bytes.toString('utf8')) : []
      })
    if (parts.history)
      data.history = await attempt(
        'history',
        async () =>
          (await readSqliteSnapshot(join(directory, 'History'), readChromiumHistory, tempRoot)) ??
          []
      )
  } else if (profile.kind === 'firefox') {
    // Bookmarks and history share one database, so one copy serves both.
    const wanted = (['bookmarks', 'history'] as const).filter((part) => parts[part])
    const now = <T>(part: Part, read: () => T): T | undefined => {
      try {
        return read()
      } catch (error) {
        data.problems.push(problem(part, error, profile))
        return undefined
      }
    }
    try {
      const read = await readSqliteSnapshot(
        join(directory, 'places.sqlite'),
        (db) => {
          if (parts.bookmarks) data.bookmarks = now('bookmarks', () => readFirefoxBookmarks(db))
          if (parts.history) data.history = now('history', () => readFirefoxHistory(db))
          return true
        },
        tempRoot
      )
      if (!read) {
        if (parts.bookmarks) data.bookmarks = []
        if (parts.history) data.history = []
      }
    } catch (error) {
      for (const part of wanted) data.problems.push(problem(part, error, profile))
    }
  } else {
    if (parts.bookmarks)
      data.bookmarks = await attempt('bookmarks', async () => {
        const bytes = await readProfileFile(
          join(directory, 'Bookmarks.plist'),
          MAX_BOOKMARKS_FILE_BYTES
        )
        return bytes ? parseSafariBookmarks(bytes) : []
      })
    if (parts.history)
      data.history = await attempt(
        'history',
        async () =>
          (await readSqliteSnapshot(join(directory, 'History.db'), readSafariHistory, tempRoot)) ??
          []
      )
  }
  return data
}

function profileLabel(profile: FoundProfile): string {
  const browser = IMPORT_BROWSER_NAMES[profile.browser]
  return profile.browser === 'safari' ? browser : `${browser} (${profile.name})`
}

/**
 * Imports bookmarks and history from browsers on this computer into SideKick, in the main process.
 * The renderer names a browser and a profile id it was shown; the profile is found again here, so
 * it cannot point the import at any other folder. Cookies, passwords, and other sign-in data are
 * never read: Chromium's app-bound encryption exists to keep other apps out of them.
 */
export class BrowserImportService {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: BrowserLibraryStore,
    private readonly options: { environment?: ImportEnvironment; tempRoot?: string } = {}
  ) {}

  private environment(): ImportEnvironment {
    return this.options.environment ?? currentImportEnvironment()
  }

  async sources(): Promise<BrowserImportSource[]> {
    return importSources(await findProfiles(this.environment()))
  }

  private async profile(browser: unknown, profileId: unknown): Promise<FoundProfile> {
    if (
      typeof browser !== 'string' ||
      !(IMPORT_BROWSERS as readonly string[]).includes(browser) ||
      typeof profileId !== 'string' ||
      profileId.length > 128
    )
      throw new Error('Choose a browser and a profile to import from.')
    const profile = (await findProfiles(this.environment())).find(
      (entry) => entry.browser === (browser as ImportBrowser) && entry.id === profileId
    )
    if (!profile) throw new Error('That browser profile is no longer on this computer.')
    return profile
  }

  /** One import at a time, so two cannot interleave their writes to the same source. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  async preview(browser: unknown, profileId: unknown): Promise<BrowserImportPreview> {
    const profile = await this.profile(browser, profileId)
    const data = await readProfile(
      profile,
      { bookmarks: true, history: true },
      this.options.tempRoot
    )
    return {
      browser: profile.browser,
      profileId: profile.id,
      label: profileLabel(profile),
      bookmarks: data.bookmarks?.length ?? 0,
      history: data.history?.length ?? 0,
      problems: data.problems
    }
  }

  run(request: BrowserImportRequest): Promise<BrowserImportResult> {
    return this.serially(async () => {
      const profile = await this.profile(request?.browser, request?.profileId)
      const parts = { bookmarks: request.bookmarks === true, history: request.history === true }
      if (!parts.bookmarks && !parts.history) throw new Error('Choose bookmarks, history, or both.')
      const data = await readProfile(profile, parts, this.options.tempRoot)
      const label = profileLabel(profile)
      this.store.replace(
        { id: `${profile.browser}:${profile.id}`, label },
        { bookmarks: data.bookmarks, history: data.history }
      )
      return {
        label,
        bookmarks: data.bookmarks?.length ?? 0,
        history: data.history?.length ?? 0,
        problems: data.problems
      }
    })
  }

  /** Imports a bookmarks file the user chose; importing a file of the same name replaces it. */
  importFile(path: string): Promise<BrowserImportResult> {
    return this.serially(async () => {
      let bytes: Buffer | undefined
      try {
        bytes = await readProfileFile(path, MAX_EXPORTED_FILE_BYTES)
      } catch (error) {
        throw new Error(
          error instanceof ProfileFileError && error.failure === 'too_large'
            ? 'That file is too large to be a bookmarks file.'
            : 'SideKick could not read that file.'
        )
      }
      if (!bytes) throw new Error('SideKick could not read that file.')
      let bookmarks: ImportedBookmark[]
      try {
        bookmarks = parseBookmarksFile(bytes.toString('utf8'))
      } catch {
        throw new Error(
          'That file is not a bookmarks file. Export bookmarks as HTML from your browser.'
        )
      }
      const name = basename(path)
      const label = `Bookmarks file ${name}`
      this.store.replace({ id: `file:${name.toLowerCase()}`, label }, { bookmarks })
      return { label, bookmarks: bookmarks.length, history: 0, problems: [] }
    })
  }
}
