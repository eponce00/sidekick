import { randomUUID } from 'crypto'
import { basename } from 'path'

export const BROWSER_PDF_SCHEME = 'sidekick-pdf'

export interface BrowserPdfSession {
  token: string
  ownerId: string
  sourcePath: string
  sourceName: string
  createdAt: number
  lastOutputPath?: string
  renderedPages: Map<string, Promise<Buffer>>
}

const sessions = new Map<string, BrowserPdfSession>()

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

export function createBrowserPdfSession(sourcePath: string, ownerId: string): BrowserPdfSession {
  const token = randomUUID()
  const session: BrowserPdfSession = {
    token,
    ownerId,
    sourcePath,
    sourceName: basename(sourcePath),
    createdAt: Date.now(),
    renderedPages: new Map()
  }
  sessions.set(token, session)
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
  sessions.delete(token)
}

export function revokeBrowserPdfSessionsByOwner(ownerId: string): void {
  for (const [token, session] of sessions) {
    if (session.ownerId === ownerId) sessions.delete(token)
  }
}
