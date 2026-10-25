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
  let annotationsChanged: ((change: { conversationId: string; focus?: string }) => void) | null
  beforeEach(() => {
    annotationsChanged = null
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
          onBrowserAnnotationsChanged: (listener: typeof annotationsChanged) => {
            annotationsChanged = listener
            return () => {
              annotationsChanged = null
            }
          }
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
  it('mounts the live viewport without a persistent resume button', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'mount',
      bounds: { x: 10, y: 100, width: 500, height: 400 }
    })
    expect(container.querySelector('input')?.value).toBe('https://example.com/')
    expect(container.querySelector('.browser-workspace-control')).toBeNull()
    expect(container.textContent).not.toContain('Take control')
    expect(container.querySelector('.browser-workspace-topbar')).not.toBeNull()
    expect(container.textContent).not.toContain('Resume agent')
  })
  it("lists the page's WebMCP tools beside the page, never over it", async () => {
    request.mockResolvedValue({
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
    })
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    const button = container.querySelector<HTMLButtonElement>('.browser-workspace-tools')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.textContent).toBe('2')
    expect(container.querySelector('#browser-page-tools')).toBeNull()

    await act(async () => button.click())
    const list = container.querySelector('#browser-page-tools')!
    expect(list.getAttribute('role')).toBeNull()
    expect(list.textContent).toContain('shop.example offers these tools to the agent')
    expect([...list.querySelectorAll('code')].map((name) => name.textContent)).toEqual([
      'add_item',
      'get_cart'
    ])
    // The site's words are text, never markup.
    expect(list.querySelector('b')).toBeNull()
    expect(list.textContent).toContain('<b>Adds</b> an item')
    expect(list.textContent).toContain('Read-only')
  })

  it('marks the page: toggles annotating, lists each mark below the page, and edits notes', async () => {
    const page = {
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Shop', url: 'https://shop.example/', active: true, loading: false }
      ],
      annotating: false,
      annotations: [
        {
          id: 'mark-1',
          number: 1,
          name: 'button “<img src=x onerror=alert(1)>”',
          note: '',
          target: 'element',
          onPage: true
        }
      ]
    }
    request.mockResolvedValue(page)
    document.documentElement.style.setProperty('--accent', '#2850b8')
    document.documentElement.style.setProperty('--on-accent', '#ffffff')
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))

    const toggle = container.querySelector<HTMLButtonElement>('.browser-workspace-annotate')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.textContent).toBe('1')
    const list = container.querySelector('.browser-workspace-annotations')!
    // Below the page, never over it, and the page's words are text, never markup.
    expect(container.querySelector('.browser-workspace-viewport')?.nextElementSibling).toBe(list)
    expect(list.querySelector('img')).toBeNull()
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>')

    await act(async () => toggle.click())
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'annotate',
      annotate: true,
      accent: '#2850b8',
      accentText: '#ffffff'
    })

    // A mark just made gets its note field.
    const field = list.querySelector<HTMLInputElement>('input')!
    await act(async () => annotationsChanged?.({ conversationId: 'chat', focus: 'mark-1' }))
    expect(document.activeElement).toBe(field)
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(field, 'Make it blue')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'annotationNote',
      annotationId: 'mark-1',
      note: 'Make it blue'
    })

    // Escape leaves the field without saving what was typed.
    request.mockClear()
    field.focus()
    await act(async () => {
      setValue.call(field, 'Never mind')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(request.mock.calls.some(([input]) => input.action === 'annotationNote')).toBe(false)

    await act(async () =>
      list.querySelector<HTMLButtonElement>('[aria-label^="Remove mark 1"]')!.click()
    )
    expect(request).toHaveBeenCalledWith({
      conversationId: 'chat',
      action: 'annotationRemove',
      annotationId: 'mark-1'
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
    expect(document.activeElement).toBe(input)
    expect(container.textContent).not.toContain('Take control')
  })
  it('says the agent goes on by itself once the user finishes the page check', async () => {
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      waitingForUser: true,
      tabs: []
    })
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(container.querySelector('[aria-label*="continues once you finish"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Resume agent')
    expect(container.textContent).not.toContain('Take control')
  })
})
