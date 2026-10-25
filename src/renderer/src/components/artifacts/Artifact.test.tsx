// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_HTML_SANDBOX_URL,
  ARTIFACT_ORIGIN,
  ARTIFACT_REACT_SANDBOX_URL
} from '../../../../shared/artifactFrame'
import { MAX_ARTIFACT_FRAME_HEIGHT } from '../../utils/artifactFrameSize'
import Artifact from './Artifact'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const writeText = vi.fn(async () => ({ success: true }))

describe('an artifact in the chat', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Object.assign(window, {
      api: { clipboard: { writeText } },
      matchMedia: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    writeText.mockClear()
  })

  async function render(
    type: 'react' | 'html' | 'svg' = 'react',
    code = `function App() { return <p>${Math.random()}</p> }`,
    onResult = vi.fn()
  ): Promise<{ frame: HTMLIFrameElement; onResult: typeof onResult }> {
    await act(async () => {
      root.render(<Artifact artifact={{ type, title: 'Tip splitter', code }} onResult={onResult} />)
    })
    return { frame: container.querySelector('iframe')!, onResult }
  }

  async function fromFrame(
    frame: HTMLIFrameElement,
    data: unknown,
    { origin = ARTIFACT_ORIGIN, source = frame.contentWindow } = {}
  ): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
    })
  }

  const stage = (): HTMLElement => container.querySelector<HTMLElement>('.artifact-stage')!

  it('runs on the artifact origin with no card around it, holding one line until it shows', async () => {
    const { frame } = await render()

    expect(frame.getAttribute('src')).toBe(ARTIFACT_REACT_SANDBOX_URL)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(container.querySelector('.artifact-container, .artifact-header')).toBeNull()
    expect(stage().classList.contains('is-shown')).toBe(false)
    expect(container.textContent).toContain('Rendering Tip splitter')
  })

  it('runs HTML and SVG in the HTML sandbox', async () => {
    const html = await render('html', '<p>Hi</p>')
    expect(html.frame.getAttribute('src')).toBe(ARTIFACT_HTML_SANDBOX_URL)
    const svg = await render('svg', '<svg viewBox="0 0 4 4"></svg>')
    expect(svg.frame.getAttribute('src')).toBe(ARTIFACT_HTML_SANDBOX_URL)
  })

  it('sends the code and theme to the artifact origin only once the frame is ready', async () => {
    const { frame } = await render('react', 'function App() { return null }')
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')

    await fromFrame(frame, { type: 'ready' })

    expect(post).toHaveBeenCalledTimes(1)
    const [command, targetOrigin] = post.mock.calls[0] as unknown as [
      { type: string; code: string; theme: { themeMode: string } },
      string
    ]
    expect(targetOrigin).toBe(ARTIFACT_ORIGIN)
    expect(command.type).toBe('render')
    expect(command.code).toBe('function App() { return null }')
    expect(['dark', 'light']).toContain(command.theme.themeMode)
  })

  it('grows and shrinks with its content, up to the limit', async () => {
    const { frame } = await render()

    await fromFrame(frame, { type: 'resize', height: 320 })
    expect(stage().classList.contains('is-shown')).toBe(true)
    expect(stage().style.height).toBe('320px')
    expect(frame.style.height).toBe('320px')

    await fromFrame(frame, { type: 'resize', height: 96 })
    expect(stage().style.height).toBe('96px')

    await fromFrame(frame, { type: 'resize', height: 9_000 })
    expect(stage().style.height).toBe(`${MAX_ARTIFACT_FRAME_HEIGHT}px`)
    expect(stage().dataset.contentHeight).toBe('9000')
  })

  it('ignores messages from another origin, another window, or of any other shape', async () => {
    const { frame } = await render()
    const other = document.createElement('iframe')
    document.body.appendChild(other)

    await fromFrame(frame, { type: 'resize', height: 500 }, { origin: 'https://example.com' })
    await fromFrame(frame, { type: 'resize', height: 500 }, { source: other.contentWindow })
    await fromFrame(frame, { type: 'resize', height: 'tall' })
    await fromFrame(frame, { type: 'resize', height: -4 })

    expect(stage().classList.contains('is-shown')).toBe(false)
    expect(stage().dataset.contentHeight).toBeUndefined()
  })

  it('shows its controls while the frame says the pointer is inside it', async () => {
    const { frame } = await render()
    const figure = container.querySelector('.artifact')!

    await fromFrame(frame, { type: 'pointer', inside: true })
    expect(figure.classList.contains('is-pointer-inside')).toBe(true)
    await fromFrame(frame, { type: 'pointer', inside: false })
    expect(figure.classList.contains('is-pointer-inside')).toBe(false)

    // A pointer that left without the frame hearing is outside once the chat sees it.
    await fromFrame(frame, { type: 'pointer', inside: true })
    await act(async () => {
      container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(figure.classList.contains('is-pointer-inside')).toBe(false)
  })

  it('reports success once', async () => {
    const { frame, onResult } = await render()

    await fromFrame(frame, { type: 'success' })
    await fromFrame(frame, { type: 'success' })

    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ title: 'Tip splitter', success: true })
  })

  it('replaces an artifact that failed before it showed with one line, and retries it', async () => {
    const { frame, onResult } = await render()

    await fromFrame(frame, { type: 'error', error: 'App is not defined\n    at eval' })

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Couldn’t show Tip splitter')
    expect(container.textContent).toContain('App is not defined')
    expect(container.textContent).not.toContain('at eval')
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'App is not defined\n    at eval' })
    )

    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => retry.click())
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  it('keeps an artifact that failed after it showed, with a note beneath it', async () => {
    const { frame } = await render()

    await fromFrame(frame, { type: 'resize', height: 200 })
    await fromFrame(frame, { type: 'error', error: 'Clicked into a bug' })

    expect(container.querySelector('iframe')).not.toBeNull()
    expect(container.querySelector('.artifact-note')?.textContent).toContain('Clicked into a bug')
  })

  it('shows its code in place, copies it, and opens full screen until Escape', async () => {
    const code = 'function App() { return <b>Code</b> }'
    await render('react', code)
    const button = (label: RegExp): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((b) =>
        label.test(b.getAttribute('aria-label') ?? '')
      )!

    await act(async () => button(/^View code$/).click())
    expect(container.querySelector('.artifact-code')?.textContent).toBe(code)
    expect(container.querySelector<HTMLElement>('.artifact-preview')?.hidden).toBe(true)

    await act(async () => button(/^Copy code$/).click())
    expect(writeText).toHaveBeenCalledWith(code)
    expect(button(/^Code copied$/)).toBeDefined()

    await act(async () => button(/full screen$/).click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('Tip splitter')
    expect(dialog?.querySelector('.artifact-stage.is-fill iframe')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
