// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWorkspace } from './BrowserWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('shared browser workspace', () => {
  let root: Root
  let container: HTMLDivElement
  const request = vi.fn()
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 100,
      width: 500,
      height: 400,
      top: 100,
      left: 10,
      right: 510,
      bottom: 500,
      toJSON() {
        return {}
      }
    })
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    request.mockReset()
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Example', url: 'https://example.com/', active: true, loading: false }
      ]
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentRuns: {
          browserWorkspace: request,
          onBrowserAnnotationsChanged: () => () => undefined
        }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('mounts the live viewport at the panel bounds', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'mount',
      bounds: { x: 10, y: 100, width: 500, height: 400 }
    })
    expect(container.querySelector('input')?.value).toBe('https://example.com/')
  })
  it("names the page's WebMCP tools in a popover over a picture of the page", async () => {
    const state = {
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Shop', url: 'https://shop.example/', active: true, loading: false }
      ],
      pageTools: {
        origin: 'https://shop.example',
        tools: [
          { name: 'add_item', description: '<b>Adds</b> an item', readOnly: false, form: false },
          { name: 'get_cart', description: 'Reads the cart', readOnly: true, form: false }
        ]
      }
    }
    request.mockImplementation(async (input: { action: string }) =>
      input.action === 'snapshot' ? { ...state, snapshot: 'data:image/png;base64,AA==' } : state
    )
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const button = container.querySelector<HTMLButtonElement>('.browser-workspace-tools')!

    await act(async () => button.click())
    expect(request).toHaveBeenCalledWith({ conversationId: 'chat', action: 'snapshot' })
    const popover = container.querySelector('#browser-page-tools')!
    // A dialog hides the live page, which is drawn above the app; its picture takes its place.
    expect(container.querySelector('.browser-workspace-snapshot')).not.toBeNull()
    expect(request).toHaveBeenLastCalledWith({ conversationId: 'chat', action: 'unmount' })

    await act(async () => popover.querySelector<HTMLButtonElement>('li button')!.click())
    const description = popover.querySelector('blockquote')!
    // The site's words are text, never markup.
    expect(description.querySelector('b')).toBeNull()
    expect(description.textContent).toBe('<b>Adds</b> an item')

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(container.querySelector('#browser-page-tools')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
  it('toggles annotating in the app’s colors and theme', async () => {
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Shop', url: 'https://shop.example/', active: true, loading: false }
      ],
      annotating: false,
      annotations: [
        { id: 'mark-1', number: 1, name: 'Button', note: '', target: 'element', onPage: true }
      ]
    })
    document.documentElement.style.setProperty('--accent', '#2850b8')
    document.documentElement.style.setProperty('--on-accent', '#ffffff')
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const toggle = container.querySelector<HTMLButtonElement>('.browser-workspace-annotate')!
    await act(async () => toggle.click())
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'annotate',
      annotate: true,
      accent: '#2850b8',
      accentText: '#ffffff',
      theme: 'dark',
      canDictate: false
    })
  })

  it('opens a new tab without needing an agent run and detaches on unmount', async () => {
    request.mockResolvedValue(null)
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(container.querySelector('input')?.disabled).toBe(false)
    await act(async () =>
      (container.querySelector('[aria-label="New browser tab"]') as HTMLButtonElement).click()
    )
    expect(request).toHaveBeenCalledWith({ conversationId: 'chat', action: 'new' })
    await act(async () => root.render(null))
    expect(request).toHaveBeenCalledWith({ conversationId: 'chat', action: 'unmount' })
  })
  it('unmounts a viewport outside the window instead of sending negative dimensions', async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: window.innerWidth + 10,
      y: 100,
      width: 500,
      height: 400
    } as DOMRect)
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(request).toHaveBeenCalledWith({ conversationId: 'chat', action: 'unmount' })
    expect(request.mock.calls.some(([input]) => input.action === 'mount')).toBe(false)
  })
  it('clears a transient layout error after a successful refresh', async () => {
    const healthy = await request()
    request.mockRejectedValue(new Error('Invalid browser panel bounds'))
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid browser panel bounds'
    )
    request.mockResolvedValue(healthy)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it('allows address editing without claiming persistent control', async () => {
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: true,
      tabs: [
        { id: 'tab', title: 'Example', url: 'https://example.com/', active: true, loading: false }
      ]
    })
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const input = container.querySelector('input')!
    await act(async () => input.focus())
    expect(request).not.toHaveBeenCalledWith({ conversationId: 'chat', action: 'control' })
    expect(input.disabled).toBe(false)
  })
  it('searches what is not an address', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const input = container.querySelector('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      input.focus()
      setValue.call(input, 'weather tomorrow')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.form!.requestSubmit())
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'url',
      url: 'https://duckduckgo.com/?q=weather%20tomorrow'
    })
  })
})
