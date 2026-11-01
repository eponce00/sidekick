import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Bookmark,
  Check,
  CircleAlert,
  FileUp,
  Globe,
  History,
  Info,
  Loader2,
  Lock,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  browserImportSourceId,
  type BrowserImportPreview,
  type BrowserImportResult,
  type BrowserImportSource,
  type BrowserLibrarySource,
  type BrowserSuggestion,
  type ImportBrowser
} from '../../../shared/browserLibrary'
import { useModalDialog } from '../hooks/useModalDialog'
import { Checkbox } from './SettingsLayout'
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

// Asked once per browser while the app runs: an installed browser's icon does not change.
const browserIcons = new Map<ImportBrowser, Promise<string | null>>()

function loadBrowserIcon(browser: ImportBrowser): Promise<string | null> {
  let icon = browserIcons.get(browser)
  if (!icon) {
    icon = window.api.browserLibrary.browserIcon(browser).catch(() => null)
    browserIcons.set(browser, icon)
  }
  return icon
}

/** The installed browser's own icon from the system, or a neutral globe when it has none. */
function BrowserIcon({ browser }: { browser: ImportBrowser }): React.JSX.Element {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void loadBrowserIcon(browser).then((found) => current && setIcon(found))
    return () => {
      current = false
    }
  }, [browser])
  return (
    <span className="browser-import-browser-icon" aria-hidden="true">
      {icon ? <img src={icon} alt="" draggable={false} /> : <Globe size={20} />}
    </span>
  )
}

const ARROW_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1
}

/**
 * Every browser profile found, as one list to import from, as Chrome's and Firefox's importers
 * list them: a browser with several profiles has a row for each. Arrow keys move the choice, as in
 * any radio group.
 */
function SourceChoice({
  sources,
  browser,
  profileId,
  disabled,
  labelledBy,
  onChange
}: {
  sources: BrowserImportSource[]
  browser: ImportBrowser | ''
  profileId: string
  disabled: boolean
  labelledBy: string
  onChange: (browser: ImportBrowser, profileId: string) => void
}): React.JSX.Element {
  const groupRef = useRef<HTMLDivElement>(null)
  const choices = sources.flatMap((source) =>
    source.profiles.map((profile) => ({
      source,
      profile,
      // A browser's only profile goes unnamed: it is just that browser.
      detail: source.profiles.length > 1 ? profile.name : null
    }))
  )
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = ARROW_STEPS[event.key]
    if (!step) return
    event.preventDefault()
    const next = choices[(index + step + choices.length) % choices.length]
    onChange(next.source.browser, next.profile.id)
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [choices.indexOf(next)]?.focus()
  }
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="browser-import-sources"
    >
      {choices.map(({ source, profile, detail }, index) => {
        const selected = source.browser === browser && profile.id === profileId
        return (
          <button
            key={`${source.browser}:${profile.id}`}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`browser-import-source${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(source.browser, profile.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <BrowserIcon browser={source.browser} />
            <span className="browser-import-source-text">
              <span className="browser-import-source-name">{source.name}</span>
              {detail && <span className="browser-import-source-profile">{detail}</span>}
            </span>
            <span className="browser-import-source-mark" aria-hidden="true" />
          </button>
        )
      })}
    </div>
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
  const browsersLabelId = useId()
  const partsLabelId = useId()
  const [sources, setSources] = useState<BrowserImportSource[] | null>(null)
  const [imported, setImported] = useState<BrowserLibrarySource[]>([])
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
    // Only says when a profile was imported before; the dialog works without it.
    void window.api.browserLibrary
      .sources()
      .then((kept) => current && setImported(kept))
      .catch(() => undefined)
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

  const previous = browser
    ? imported.find((entry) => entry.id === browserImportSourceId(browser, profileId))
    : undefined
  const found = Boolean(sources?.length)
  const keptAnything = Boolean(result && (result.bookmarks || result.history))
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
  const importFile = (): void => void run(() => window.api.browserLibrary.importBookmarksFile())
  const problemFor = (part: 'bookmarks' | 'history'): string | undefined =>
    preview?.problems.find((problem) => problem.part === part)?.message

  // On the page body, so no panel's stacking context can draw the chat above the dialog.
  return createPortal(
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
          <div>
            <h2 id={titleId}>Import browser data</h2>
            <p>Bookmarks and history stay on this computer.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="browser-import-body">
          {result ? (
            <div className="browser-import-done" role="status">
              <span className={`browser-import-done-icon${keptAnything ? ' is-success' : ''}`}>
                {keptAnything ? <Check size={16} /> : <Info size={16} />}
              </span>
              <div>
                <p className="browser-import-result">{importSummary(result)}</p>
                {result.problems.map((problem) => (
                  <p key={problem.part} className="browser-import-problem">
                    <TriangleAlert size={13} aria-hidden="true" />
                    {problem.message}
                  </p>
                ))}
              </div>
            </div>
          ) : sources === null && !error ? (
            <div className="browser-import-loading" role="status">
              <Loader2 size={16} className="icon-spin" aria-hidden="true" />
              Looking for browsers on this computer…
            </div>
          ) : sources?.length === 0 ? (
            <div className="browser-import-empty">
              <span className="browser-import-empty-icon">
                <Globe size={20} aria-hidden="true" />
              </span>
              <strong>No browsers found</strong>
              <p>
                SideKick found no Chrome, Edge, Brave, Chromium, Arc, Firefox, or Safari data on
                this computer. You can import a bookmarks file exported from any browser instead.
              </p>
            </div>
          ) : sources ? (
            <>
              <section className="browser-import-section">
                <span id={browsersLabelId} className="browser-import-label">
                  Import from
                </span>
                <SourceChoice
                  sources={sources}
                  browser={browser}
                  profileId={profileId}
                  disabled={busy}
                  labelledBy={browsersLabelId}
                  onChange={(nextBrowser, nextProfile) => {
                    setBrowser(nextBrowser)
                    setProfileId(nextProfile)
                  }}
                />
              </section>

              <section
                className="browser-import-section"
                aria-labelledby={partsLabelId}
                aria-busy={!preview}
              >
                <span id={partsLabelId} className="browser-import-label">
                  Include
                </span>
                <div className="browser-import-parts">
                  {(['bookmarks', 'history'] as const).map((part) => {
                    const total = preview?.[part] ?? 0
                    const problem = problemFor(part)
                    const Icon = part === 'bookmarks' ? Bookmark : History
                    return (
                      <label key={part} className="browser-import-part">
                        <Checkbox
                          checked={parts[part]}
                          disabled={busy || !preview || total === 0 || Boolean(problem)}
                          onChange={(checked) =>
                            setParts((current) => ({ ...current, [part]: checked }))
                          }
                        />
                        <Icon size={14} aria-hidden="true" />
                        <span className="browser-import-part-name">
                          {part === 'bookmarks' ? 'Bookmarks' : 'History'}
                        </span>
                        <span className="browser-import-part-count">
                          {!preview
                            ? 'Reading…'
                            : problem
                              ? 'Unavailable'
                              : total
                                ? part === 'bookmarks'
                                  ? count(total, 'bookmark', 'bookmarks')
                                  : count(total, 'page', 'pages')
                                : 'None'}
                        </span>
                        {problem && <span className="browser-import-part-problem">{problem}</span>}
                      </label>
                    )
                  })}
                </div>
                {previous && (
                  <p className="browser-library-note">
                    Imported {new Date(previous.importedAt).toLocaleDateString()}. Importing again
                    replaces it.
                  </p>
                )}
              </section>
            </>
          ) : null}

          {error && (
            <p role="alert" className="browser-import-error">
              <CircleAlert size={14} aria-hidden="true" />
              {error}
            </p>
          )}

          {!result && found && (
            <p className="browser-import-footnote">
              <Lock size={11} aria-hidden="true" />
              The agent never sees imported data. Passwords, cookies, and sign-ins are not imported.
            </p>
          )}
        </div>

        <div className="browser-import-footer">
          {result ? (
            <button type="button" className="browser-import-button is-primary" onClick={onClose}>
              Done
            </button>
          ) : found ? (
            <>
              <button
                type="button"
                className="browser-import-button is-quiet"
                disabled={busy}
                onClick={importFile}
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
                {busy && <Loader2 size={14} className="icon-spin" aria-hidden="true" />}
                {busy ? 'Importing…' : 'Import'}
              </button>
            </>
          ) : (
            <>
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
                disabled={busy || (sources === null && !error)}
                onClick={importFile}
              >
                <FileUp size={14} aria-hidden="true" />
                Import a bookmarks file…
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
