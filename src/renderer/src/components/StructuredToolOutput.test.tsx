// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnsiTerminalOutput, FileListOutput, ReadFileOutput } from './StructuredToolOutput'

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

  it('shows terminal output as the terminal would, after a carriage return', async () => {
    await act(async () =>
      root.render(<AnsiTerminalOutput value={'\u001b[31mfailed\u001b[0m\rpassed'} />)
    )
    expect(container.textContent).toContain('passed')
    expect(container.textContent).not.toContain('failed')
  })

  it('opens read results and file lists with directory-aware actions', async () => {
    await act(async () =>
      root.render(
        <ReadFileOutput
          data={{ content: 'hello', startLine: 4, endLine: 8, totalLines: 20 }}
          path="src/App.tsx"
          workspaceRoot="C:/repo"
        />
      )
    )
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    expect(openFile).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')

    await act(async () =>
      root.render(
        <FileListOutput data={{ files: ['src/', 'src/App.tsx'] }} workspaceRoot="C:/repo" />
      )
    )
    const buttons = container.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => {
      buttons[0].click()
      buttons[1].click()
    })
    expect(openFolder).toHaveBeenCalledWith('src/', 'C:/repo')
    expect(openFile).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')
    await act(async () =>
      buttons[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    )
    expect(showPathMenu).toHaveBeenCalledWith('src/', 'C:/repo', true)
  })
})
