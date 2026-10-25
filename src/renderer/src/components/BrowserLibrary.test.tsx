// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLibraryAPI } from '../../../shared/browserLibrary'
import { BrowserImportDialog } from './BrowserLibrary'
import { BrowserWorkspace } from './BrowserWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(element: Element, name: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
}

describe('imported browser data in the Browser panel', () => {
  let root: Root
  let container: HTMLDivElement
  const browserWorkspace = vi.fn()
  let library: { [K in keyof BrowserLibraryAPI]: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    browserWorkspace.mockReset()
    browserWorkspace.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Example', url: 'https://example.com/', active: true, loading: false }
      ]
    })
    library = {
      importSources: vi.fn().mockResolvedValue([
        {
          browser: 'chrome',
          name: 'Google Chrome',
          profiles: [
            { id: 'Default', name: 'Personal' },
            { id: 'Profile 1', name: 'Work' }
          ]
        }
      ]),
      previewImport: vi.fn().mockResolvedValue({
        browser: 'chrome',
        profileId: 'Default',
        label: 'Google Chrome (Personal)',
        bookmarks: 12,
        history: 0,
        problems: [{ part: 'history', message: 'Google Chrome is using its history file.' }]
      }),
      runImport: vi.fn().mockResolvedValue({
        label: 'Google Chrome (Personal)',
        bookmarks: 12,
        history: 0,
        problems: []
      }),
      importBookmarksFile: vi.fn().mockResolvedValue(null),
      sources: vi.fn().mockResolvedValue([]),
      bookmarks: vi.fn().mockResolvedValue([]),
      suggest: vi.fn().mockResolvedValue([
        { url: 'https://github.com/', title: 'GitHub', kind: 'bookmark' },
        { url: 'https://gitlab.com/', title: 'GitLab', kind: 'history' }
      ]),
      remove: vi.fn().mockResolvedValue([])
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentRuns: { browserWorkspace, onBrowserAnnotationsChanged: () => () => undefined },
        browserLibrary: library
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const address = (): HTMLInputElement =>
    container.querySelector('input[aria-label="Browser address"]') as HTMLInputElement

  it('suggests imported addresses as the user types and opens the one chosen by keyboard', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const input = address()
    await act(async () => {
      input.focus()
      type(input, 'git')
    })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(library.suggest).toHaveBeenLastCalledWith('git')
    const options = container.querySelectorAll('[role="option"]')
    expect([...options].map((option) => option.textContent)).toEqual([
      'GitHubgithub.com',
      'GitLabgitlab.com'
    ])
    expect(input.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      key(input, 'ArrowDown')
      key(input, 'ArrowDown')
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('browser-suggestions-1')
    await act(async () => {
      input.form!.requestSubmit()
    })
    expect(browserWorkspace).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'url',
      url: 'https://gitlab.com/'
    })
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('closes suggestions on Escape and leaves the typed address alone', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const input = address()
    await act(async () => {
      input.focus()
      type(input, 'git')
    })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    await act(async () => key(input, 'Escape'))
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(input.value).toBe('git')
  })

  it('opens the bookmarks list above the page and offers an import when it is empty', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const button = container.querySelector('button[aria-label="Bookmarks"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const section = container.querySelector('#browser-bookmarks')!
    // Laid out before the page's viewport, never inside it.
    expect(
      section.compareDocumentPosition(container.querySelector('.browser-workspace-viewport')!)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(section.textContent).toContain('Import from another browser')
  })

  it('shows imported bookmarks by folder and opens one', async () => {
    library.sources.mockResolvedValue([
      {
        id: 'chrome:Default',
        label: 'Google Chrome (Personal)',
        importedAt: 1,
        bookmarks: 2,
        history: 0
      }
    ])
    library.bookmarks.mockResolvedValue([
      {
        sourceId: 'chrome:Default',
        folder: ['Bookmarks bar'],
        title: 'GitHub',
        url: 'https://github.com/'
      },
      {
        sourceId: 'chrome:Default',
        folder: ['Bookmarks bar', 'Docs'],
        title: 'MDN',
        url: 'https://developer.mozilla.org/'
      }
    ])
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    await act(async () =>
      (container.querySelector('button[aria-label="Bookmarks"]') as HTMLButtonElement).click()
    )
    const tree = container.querySelector('[role="tree"]')!
    expect(tree.textContent).toContain('Bookmarks bar')
    expect(tree.textContent).toContain('GitHub')
    // Folders below the first stay closed, and render nothing until opened.
    expect(tree.textContent).not.toContain('MDN')
    const docs = [...tree.querySelectorAll('button[aria-expanded]')].find((node) =>
      node.textContent?.includes('Docs')
    ) as HTMLButtonElement
    await act(async () => docs.click())
    expect(tree.textContent).toContain('MDN')
    const github = [...tree.querySelectorAll('button')].find(
      (node) => node.textContent === 'GitHub'
    ) as HTMLButtonElement
    await act(async () => github.click())
    expect(browserWorkspace).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'url',
      url: 'https://github.com/'
    })
    expect(container.querySelector('#browser-bookmarks')).toBeNull()
  })

  it('previews a profile, keeps a part it cannot read unchecked, and imports what is chosen', async () => {
    const onImported = vi.fn()
    await act(async () =>
      root.render(<BrowserImportDialog isOpen onClose={vi.fn()} onImported={onImported} />)
    )
    expect(library.previewImport).toHaveBeenCalledWith('chrome', 'Default')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('12 bookmarks')
    expect(dialog.textContent).toContain('Google Chrome is using its history file.')
    const [bookmarks, history] = [
      ...dialog.querySelectorAll('input[type="checkbox"]')
    ] as HTMLInputElement[]
    expect(bookmarks.checked).toBe(true)
    expect(history.checked).toBe(false)
    expect(history.disabled).toBe(true)
    const importButton = [...dialog.querySelectorAll('button')].find(
      (node) => node.textContent === 'Import'
    )!
    await act(async () => importButton.click())
    expect(library.runImport).toHaveBeenCalledWith({
      browser: 'chrome',
      profileId: 'Default',
      bookmarks: true,
      history: false
    })
    expect(onImported).toHaveBeenCalled()
    expect(dialog.textContent).toContain('Imported 12 bookmarks from Google Chrome (Personal).')
  })

  it('says so when no browser is found, and still offers a bookmarks file', async () => {
    library.importSources.mockResolvedValue([])
    await act(async () => root.render(<BrowserImportDialog isOpen onClose={vi.fn()} />))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('found no Chrome')
    const file = [...dialog.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('bookmarks file')
    )!
    await act(async () => file.click())
    expect(library.importBookmarksFile).toHaveBeenCalled()
    expect(library.previewImport).not.toHaveBeenCalled()
  })

  it('shows the main process message without Electron’s prefix', async () => {
    library.runImport.mockRejectedValue(
      new Error(
        "Error invoking remote method 'browserLibrary:runImport': Error: That browser profile is no longer on this computer."
      )
    )
    library.previewImport.mockResolvedValue({
      browser: 'chrome',
      profileId: 'Default',
      label: 'Google Chrome (Personal)',
      bookmarks: 3,
      history: 0,
      problems: []
    })
    await act(async () => root.render(<BrowserImportDialog isOpen onClose={vi.fn()} />))
    const dialog = document.querySelector('[role="dialog"]')!
    const importButton = [...dialog.querySelectorAll('button')].find(
      (node) => node.textContent === 'Import'
    )!
    await act(async () => importButton.click())
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      'That browser profile is no longer on this computer.'
    )
  })
})
