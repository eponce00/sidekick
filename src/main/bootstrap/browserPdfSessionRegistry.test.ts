import { describe, expect, it } from 'vitest'
import {
  browserPdfUrlAllowed,
  browserPdfViewerUrl,
  createBrowserPdfSession,
  getBrowserPdfSession,
  revokeBrowserPdfSession,
  revokeBrowserPdfSessionsByOwner
} from './browserPdfSessionRegistry'

describe('browserPdfSessionRegistry', () => {
  it('keeps PDF protocol capabilities scoped to their owning browser session', () => {
    const session = createBrowserPdfSession('C:\\project\\form.pdf', 'browser-session-1')
    const url = browserPdfViewerUrl(session)

    expect(getBrowserPdfSession(url)).toBe(session)
    expect(browserPdfUrlAllowed(url, 'browser-session-1')).toBe(true)
    expect(browserPdfUrlAllowed(url, 'browser-session-2')).toBe(false)

    revokeBrowserPdfSession(session.token)
    expect(getBrowserPdfSession(url)).toBeUndefined()
  })

  it('revokes every token owned by a closed browser session', () => {
    const first = createBrowserPdfSession('C:\\project\\first.pdf', 'browser-session-1')
    const second = createBrowserPdfSession('C:\\project\\second.pdf', 'browser-session-1')
    const other = createBrowserPdfSession('C:\\project\\other.pdf', 'browser-session-2')

    revokeBrowserPdfSessionsByOwner('browser-session-1')

    expect(getBrowserPdfSession(browserPdfViewerUrl(first))).toBeUndefined()
    expect(getBrowserPdfSession(browserPdfViewerUrl(second))).toBeUndefined()
    expect(getBrowserPdfSession(browserPdfViewerUrl(other))).toBe(other)
    revokeBrowserPdfSession(other.token)
  })
})
