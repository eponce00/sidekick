import { randomUUID } from 'crypto'
import { basename, dirname } from 'path'
import {
  capturePublicationDirectory,
  type PublicationDirectory
} from '../utils/publicationDirectory'
import { BrowserPdfSnapshotError, readBrowserPdfSnapshot } from './browserPdfSnapshot'

export const BROWSER_PDF_SCHEME = 'sidekick-pdf'

export interface BrowserPdfSession {
  token: string
  ownerId: string
  sourcePath: string
  sourceName: string
  /** Original file:// or remote URL exposed to the agent while the private viewer is active. */
  logicalUrl?: string
  /** Trusted host-selected destination for a filled copy of a downloaded remote PDF. */
  outputDirectory?: string
  createdAt: number
  lastOutputPath?: string
  renderedPages: Map<string, Promise<Buffer>>
}

export interface BrowserPdfSessionOptions {
  publicationRoot?: string
  sourceName?: string
  logicalUrl?: string
  outputDirectory?: string
}

const sessions = new Map<string, BrowserPdfSession>()
const snapshots = new WeakMap<BrowserPdfSession, Promise<Buffer>>()
const lifetimes = new WeakMap<BrowserPdfSession, AbortController>()
const publicationDirectories = new WeakMap<
  BrowserPdfSession,
  Promise<PublicationDirectory | null>
>()

export async function browserPdfPublicationDirectory(
  session: BrowserPdfSession
): Promise<PublicationDirectory> {
  browserPdfSessionSignal(session).throwIfAborted()
  const guard = await publicationDirectories.get(session)
  browserPdfSessionSignal(session).throwIfAborted()
  if (!guard)
    throw new Error(
      'Publication directory changed or is unavailable; reopen the document or retry the download'
    )
  return guard
}

/** Revoked and foreign session objects never receive a usable capability signal. */
export function browserPdfSessionSignal(session: BrowserPdfSession): AbortSignal {
  if (sessions.get(session.token) !== session) {
    return AbortSignal.abort(new BrowserPdfSnapshotError('unavailable'))
  }
  return (
    lifetimes.get(session)?.signal ?? AbortSignal.abort(new BrowserPdfSnapshotError('unavailable'))
  )
}

/** Each consumer receives its own bytes; PDF.js may transfer or mutate its input. */
export async function browserPdfSessionBytes(
  session: BrowserPdfSession
): Promise<Uint8Array<ArrayBuffer>> {
  const assertActive = (): void => {
    if (sessions.get(session.token) !== session) throw new BrowserPdfSnapshotError('unavailable')
  }
  assertActive()
  let snapshot = snapshots.get(session)
  if (!snapshot) {
    snapshot = readBrowserPdfSnapshot(session.sourcePath, assertActive)
    // Keep failures too: a retry must never silently switch this session's version.
    snapshots.set(session, snapshot)
  }
  const bytes = await snapshot
  assertActive()
  return new Uint8Array(bytes)
}

function tokenFromUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== `${BROWSER_PDF_SCHEME}:` || url.hostname !== 'viewer') return null
    const token = url.pathname.split('/').filter(Boolean)[0]
    return token && /^[0-9a-f-]{36}$/i.test(token) ? token : null
  } catch {
    return null
  }
}

export function createBrowserPdfSession(
  sourcePath: string,
  ownerId: string,
  options: BrowserPdfSessionOptions = {}
): BrowserPdfSession {
  const token = randomUUID()
  const session: BrowserPdfSession = {
    token,
    ownerId,
    sourcePath,
    sourceName: options.sourceName ?? basename(sourcePath),
    logicalUrl: options.logicalUrl,
    outputDirectory: options.outputDirectory,
    createdAt: Date.now(),
    renderedPages: new Map()
  }
  sessions.set(token, session)
  const lifetime = new AbortController()
  lifetimes.set(session, lifetime)
  const directory = options.outputDirectory ?? dirname(sourcePath)
  // Capture eagerly, before the viewer's arbitrarily long editing lifetime. A
  // settled result observes rejection even when this read-only session never saves.
  publicationDirectories.set(
    session,
    capturePublicationDirectory(
      options.publicationRoot ?? directory,
      directory,
      Boolean(options.outputDirectory)
    ).then(
      (guard) => (lifetime.signal.aborted ? null : guard),
      () => null
    )
  )
  return session
}

export function browserPdfViewerUrl(session: BrowserPdfSession): string {
  return `${BROWSER_PDF_SCHEME}://viewer/${session.token}/index.html`
}

export function getBrowserPdfSession(input: string): BrowserPdfSession | undefined {
  const token = tokenFromUrl(input)
  return token ? sessions.get(token) : undefined
}

export function browserPdfUrlAllowed(input: string, ownerId: string): boolean {
  return getBrowserPdfSession(input)?.ownerId === ownerId
}

export function revokeBrowserPdfSession(token: string): void {
  const session = sessions.get(token)
  sessions.delete(token)
  if (session) {
    lifetimes.get(session)?.abort(new BrowserPdfSnapshotError('unavailable'))
    lifetimes.delete(session)
    snapshots.delete(session)
    publicationDirectories.delete(session)
    session.renderedPages.clear()
  }
}

export function revokeBrowserPdfSessionsByOwner(ownerId: string): void {
  for (const [token, session] of sessions) {
    if (session.ownerId === ownerId) revokeBrowserPdfSession(token)
  }
}
