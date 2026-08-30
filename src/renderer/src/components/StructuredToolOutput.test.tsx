// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnsiTerminalOutput,
  FileListOutput,
  JsonTreeView,
  ReadFileOutput,
  SearchResultsOutput,
  WebPageOutput
} from './StructuredToolOutput'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('structured tool outputs', () => {
  let container: HTMLDivElement
  let root: Root
  const openFile = vi.fn(async () => undefined)
  const openFolder = vi.fn(async () => undefined)
  const showPathMenu = vi.fn(async () => undefined)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { workspace: { openFile, openFolder, showPathMenu } }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.clearAllMocks()
    container.remove()
  })

  it('normalizes ANSI terminal output and expands JSON branches', async () => {
    await act(async () => root.render(<AnsiTerminalOutput value={'\u001b[31mfailed\u001b[0m\rpassed'} />))
    expect(container.textContent).toContain('passed')

    await act(async () => root.render(<JsonTreeView value={{ nested: { value: 4 }, list: [1, 2] }} />))
    const toggles = container.querySelectorAll<HTMLButtonElement>('.json-tree-node > button')
    expect(toggles.length).toBeGreaterThan(1)
    await act(async () => toggles[1].click())
    expect(toggles[1].getAttribute('aria-expanded')).toBe('false')
  })

  it('renders linked text and image search results', async () => {
    await act(async () => root.render(<SearchResultsOutput data={{ results: [
      { title: 'Docs', url: 'https://example.com/docs', description: 'Reference' }
    ] }} />))
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
    expect(container.textContent).toContain('Reference')

    await act(async () => root.render(<SearchResultsOutput data={{ results: [
      { title: 'Preview', imageUrl: 'https://example.com/image.png', pageUrl: 'https://example.com/page' }
    ] }} />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.png')
  })

  it('renders web metadata, source link, and bounded content', async () => {
    await act(async () => root.render(<WebPageOutput data={{
      title: 'Example', byline: 'Author', url: 'https://example.com/article', excerpt: 'Summary', content: 'Body'
    }} />))
    expect(container.textContent).toContain('Author')
    expect(container.textContent).toContain('Summary')
    expect(container.querySelector('a')?.textContent).toContain('Open source')
  })

  it('opens read results and file lists with directory-aware actions', async () => {
    await act(async () => root.render(<ReadFileOutput
      data={{ content: 'hello', startLine: 4, endLine: 8, totalLines: 20 }}
      path="src/App.tsx"
      workspaceRoot="C:/repo"
    />))
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    expect(openFile).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')

    await act(async () => root.render(<FileListOutput data={{ files: ['src/', 'src/App.tsx'] }} workspaceRoot="C:/repo" />))
    const buttons = container.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => { buttons[0].click(); buttons[1].click() })
    expect(openFolder).toHaveBeenCalledWith('src/', 'C:/repo')
    expect(openFile).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')
    await act(async () => buttons[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(showPathMenu).toHaveBeenCalledWith('src/', 'C:/repo', true)
  })
})
