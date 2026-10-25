import { useEffect, useId, useMemo, useState } from 'react'
import { Bookmark, ChevronRight, FileUp, Folder, History, Import, X } from 'lucide-react'
import type {
  BrowserBookmark,
  BrowserImportPreview,
  BrowserImportResult,
  BrowserImportSource,
  BrowserLibrarySource,
  BrowserSuggestion,
  ImportBrowser
} from '../../../shared/browserLibrary'
import { useModalDialog } from '../hooks/useModalDialog'
import { Select } from './Select'
import './BrowserLibrary.css'

/** The main process's own message, without Electron's prefix. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`
}

/** What an import kept, in one sentence. */
function importSummary(result: BrowserImportResult): string {
  const parts = [
    result.bookmarks ? count(result.bookmarks, 'bookmark', 'bookmarks') : '',
    result.history ? count(result.history, 'page', 'pages') + ' of history' : ''
  ].filter(Boolean)
  return parts.length
    ? `Imported ${parts.join(' and ')} from ${result.label}.`
    : `Nothing was imported from ${result.label}.`
}

/** An address as people read it: no scheme, no `www.`, no trailing slash. */
function shortAddress(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
}

/**
 * Addresses from imported bookmarks and history that match the address bar. Laid out above the
 * page, never over it: the page is drawn above the app.
 */
export function BrowserSuggestions({
  id,
  suggestions,
  active,
  onPick
}: {
  id: string
  suggestions: BrowserSuggestion[]
  active: number
  onPick: (suggestion: BrowserSuggestion) => void
}): React.JSX.Element {
  return (
    <ul id={id} role="listbox" aria-label="Suggestions" className="browser-library-suggestions">
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.url}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          title={suggestion.url}
          // Keeps focus in the address bar, so the list stays until the pick navigates.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(suggestion)}
        >
          {suggestion.kind === 'bookmark' ? (
            <Bookmark size={13} aria-label="Bookmark" />
          ) : (
            <History size={13} aria-label="History" />
          )}
          <span className="browser-library-suggestion-title">
            {suggestion.title || shortAddress(suggestion.url)}
          </span>
          <span className="browser-library-suggestion-url">{shortAddress(suggestion.url)}</span>
        </li>
      ))}
    </ul>
  )
}

interface FolderNode {
  name: string
  folders: Map<string, FolderNode>
  bookmarks: BrowserBookmark[]
  total: number
}

function folderNode(name: string): FolderNode {
  return { name, folders: new Map(), bookmarks: [], total: 0 }
}

/** Folders in the order their first bookmark appears; with several imports, one folder each. */
function bookmarkTree(bookmarks: BrowserBookmark[], sources: BrowserLibrarySource[]): FolderNode {
  const root = folderNode('')
  const several = new Set(bookmarks.map((bookmark) => bookmark.sourceId)).size > 1
  const labels = new Map(sources.map((source) => [source.id, source.label]))
  for (const bookmark of bookmarks) {
    const path = several
      ? [labels.get(bookmark.sourceId) ?? 'Imported', ...bookmark.folder]
      : bookmark.folder
    let node = root
    node.total++
    for (const name of path) {
      let next = node.folders.get(name)
      if (!next) {
        next = folderNode(name)
        node.folders.set(name, next)
      }
      node = next
      node.total++
    }
    node.bookmarks.push(bookmark)
  }
  return root
}

function BookmarkFolder({
  node,
  initiallyOpen,
  onOpen
}: {
  node: FolderNode
  initiallyOpen: boolean
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <li className="browser-library-folder">
      <button
        type="button"
        className="browser-library-folder-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={13} aria-hidden="true" />
        <Folder size={13} aria-hidden="true" />
        <span>{node.name}</span>
        <span className="browser-library-count">{node.total.toLocaleString()}</span>
      </button>
      {/* A closed folder renders nothing inside it, so thousands of bookmarks stay cheap. */}
      {open && <BookmarkList node={node} onOpen={onOpen} />}
    </li>
  )
}

function BookmarkList({
  node,
  onOpen,
  top = false
}: {
  node: FolderNode
  onOpen: (url: string) => void
  top?: boolean
}): React.JSX.Element {
  const folders = [...node.folders.values()]
  return (
    <ul role={top ? 'tree' : 'group'} aria-label={top ? 'Bookmarks' : undefined}>
      {folders.map((folder, index) => (
        <BookmarkFolder
          key={folder.name}
          node={folder}
          initiallyOpen={top && index === 0}
          onOpen={onOpen}
        />
      ))}
      {node.bookmarks.map((bookmark, index) => (
        <li key={`${index}:${bookmark.url}`}>
          <button
            type="button"
            className="browser-library-bookmark"
            title={bookmark.url}
            onClick={() => onOpen(bookmark.url)}
          >
            <Bookmark size={13} aria-hidden="true" />
            <span>{bookmark.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The bookmarks list in the Browser panel, laid out above the page like the page's tools. */
export function BrowserBookmarks({
  version,
  onOpen,
  onImport
}: {
  /** Changes after an import, to read the list again. */
  version: number
  onOpen: (url: string) => void
  onImport: () => void
}): React.JSX.Element {
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[] | null>(null)
  const [sources, setSources] = useState<BrowserLibrarySource[]>([])

  useEffect(() => {
    let current = true
    void Promise.all([window.api.browserLibrary.bookmarks(), window.api.browserLibrary.sources()])
      .then(([list, imported]) => {
        if (!current) return
        setBookmarks(list)
        setSources(imported)
      })
      .catch(() => current && setBookmarks([]))
    return () => {
      current = false
    }
  }, [version])

  const tree = useMemo(() => bookmarkTree(bookmarks ?? [], sources), [bookmarks, sources])

  return (
    <section id="browser-bookmarks" className="browser-library-bookmarks" aria-label="Bookmarks">
      {bookmarks === null ? (
        <p className="browser-library-note">Loading bookmarks…</p>
      ) : bookmarks.length === 0 ? (
        <div className="browser-library-empty">
          <p className="browser-library-note">
            {sources.length
              ? 'Your imports have no bookmarks. Their history still suggests addresses as you type.'
              : 'Bring your bookmarks and history from another browser on this computer. They fill this list and suggest addresses as you type.'}
          </p>
          <button type="button" className="browser-library-action" onClick={onImport}>
            <Import size={13} aria-hidden="true" />
            Import from another browser…
          </button>
        </div>
      ) : (
        <>
          <BookmarkList node={tree} onOpen={onOpen} top />
          <button type="button" className="browser-library-action is-quiet" onClick={onImport}>
            <Import size={13} aria-hidden="true" />
            Import again or from another browser…
          </button>
        </>
      )}
    </section>
  )
}

/** Chooses a browser and profile, shows what it holds, and imports the parts the user keeps. */
export function BrowserImportDialog({
  isOpen,
  onClose,
  onImported
}: {
  isOpen: boolean
  onClose: () => void
  onImported?: (result: BrowserImportResult) => void
}): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, onClose)
  const titleId = useId()
  const [sources, setSources] = useState<BrowserImportSource[] | null>(null)
  const [browser, setBrowser] = useState<ImportBrowser | ''>('')
  const [profileId, setProfileId] = useState('')
  const [preview, setPreview] = useState<BrowserImportPreview | null>(null)
  const [parts, setParts] = useState({ bookmarks: true, history: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BrowserImportResult | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let current = true
    setSources(null)
    setResult(null)
    setError('')
    setPreview(null)
    void window.api.browserLibrary
      .importSources()
      .then((found) => {
        if (!current) return
        setSources(found)
        setBrowser(found[0]?.browser ?? '')
        setProfileId(found[0]?.profiles[0]?.id ?? '')
      })
      .catch((e) => current && setError(errorText(e)))
    return () => {
      current = false
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !browser || !profileId) return
    let current = true
    setPreview(null)
    setError('')
    void window.api.browserLibrary
      .previewImport(browser, profileId)
      .then((found) => {
        if (!current) return
        setPreview(found)
        const blocked = new Set(found.problems.map((problem) => problem.part))
        setParts({
          bookmarks: found.bookmarks > 0 && !blocked.has('bookmarks'),
          history: found.history > 0 && !blocked.has('history')
        })
      })
      .catch((e) => current && setError(errorText(e)))
    return () => {
      current = false
    }
  }, [isOpen, browser, profileId])

  if (!isOpen) return null

  const source = sources?.find((entry) => entry.browser === browser)
  const finish = (done: BrowserImportResult): void => {
    setResult(done)
    onImported?.(done)
  }
  const run = async (work: () => Promise<BrowserImportResult | null>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const done = await work()
      if (done) finish(done)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const problemFor = (part: 'bookmarks' | 'history'): string | undefined =>
    preview?.problems.find((problem) => problem.part === part)?.message

  return (
    <div
      className="browser-import-backdrop"
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        className="browser-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="browser-import-header">
          <span className="browser-import-icon">
            <Import size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id={titleId}>Import from another browser</h2>
            <p>
              Bookmarks and history fill the Browser panel&apos;s bookmarks and suggest addresses as
              you type. They stay on this computer, and the agent never sees them. Passwords,
              cookies, and sign-ins are not imported.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {result ? (
          <div className="browser-import-body" role="status">
            <p className="browser-import-result">{importSummary(result)}</p>
            {result.problems.map((problem) => (
              <p key={problem.part} className="browser-import-problem">
                {problem.message}
              </p>
            ))}
          </div>
        ) : (
          <div className="browser-import-body">
            {sources === null && !error ? (
              <p className="browser-library-note">Looking for browsers on this computer…</p>
            ) : sources?.length === 0 ? (
              <p className="browser-library-note">
                SideKick found no Chrome, Edge, Brave, Chromium, Arc, Firefox, or Safari data on
                this computer. You can still import a bookmarks file exported from any browser.
              </p>
            ) : sources ? (
              <>
                <label className="browser-import-field">
                  <span>Browser</span>
                  <Select
                    aria-label="Browser"
                    value={browser}
                    disabled={busy}
                    onChange={(event) => {
                      const next = sources.find((entry) => entry.browser === event.target.value)
                      setBrowser(next?.browser ?? '')
                      setProfileId(next?.profiles[0]?.id ?? '')
                    }}
                  >
                    {sources.map((entry) => (
                      <option key={entry.browser} value={entry.browser}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </label>
                {source && source.profiles.length > 1 && (
                  <label className="browser-import-field">
                    <span>Profile</span>
                    <Select
                      aria-label="Profile"
                      value={profileId}
                      disabled={busy}
                      onChange={(event) => setProfileId(event.target.value)}
                    >
                      {source.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <fieldset className="browser-import-parts" aria-busy={!preview}>
                  <legend>What to import</legend>
                  {(['bookmarks', 'history'] as const).map((part) => {
                    const total = preview?.[part] ?? 0
                    const problem = problemFor(part)
                    return (
                      <label key={part} className="browser-import-part">
                        <input
                          type="checkbox"
                          checked={parts[part]}
                          disabled={busy || !preview || total === 0 || Boolean(problem)}
                          onChange={(event) =>
                            setParts((current) => ({ ...current, [part]: event.target.checked }))
                          }
                        />
                        <span>
                          <strong>{part === 'bookmarks' ? 'Bookmarks' : 'History'}</strong>
                          <small>
                            {!preview
                              ? 'Reading…'
                              : problem
                                ? problem
                                : part === 'bookmarks'
                                  ? total
                                    ? count(total, 'bookmark', 'bookmarks')
                                    : 'No bookmarks'
                                  : total
                                    ? `${count(total, 'page', 'pages')}, most visited first`
                                    : 'No history'}
                          </small>
                        </span>
                      </label>
                    )
                  })}
                </fieldset>
                <p className="browser-library-note">
                  Importing the same profile again replaces what it imported before.
                </p>
              </>
            ) : null}
          </div>
        )}

        {error && (
          <p role="alert" className="browser-import-error">
            {error}
          </p>
        )}

        <div className="browser-import-footer">
          {result ? (
            <button type="button" className="browser-import-button is-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="browser-import-button is-link"
                disabled={busy}
                onClick={() => void run(() => window.api.browserLibrary.importBookmarksFile())}
              >
                <FileUp size={14} aria-hidden="true" />
                Import a bookmarks file…
              </button>
              <button
                type="button"
                className="browser-import-button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="browser-import-button is-primary"
                disabled={busy || !preview || (!parts.bookmarks && !parts.history)}
                onClick={() =>
                  void run(() =>
                    window.api.browserLibrary.runImport({
                      browser: browser as ImportBrowser,
                      profileId,
                      ...parts
                    })
                  )
                }
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
