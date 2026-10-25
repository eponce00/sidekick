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
      value: { agentRuns: { browserWorkspace: request } }
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
  it('shows nothing for a page without tools', async () => {
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(container.querySelector('.browser-workspace-tools')).toBeNull()
    expect(container.querySelector('.browser-workspace-address.has-tools')).toBeNull()
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
    // The indicator lives inside the address field, so nothing around it moves.
    const button = container.querySelector<HTMLButtonElement>(
      '.browser-workspace-address .browser-workspace-tools'
    )!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-label')).toBe('Tools this page offers the agent: 2')
    expect(button.textContent).toBe('')
    expect(container.querySelector('#browser-page-tools')).toBeNull()

    await act(async () => button.click())
    expect(request).toHaveBeenCalledWith({ conversationId: 'chat', action: 'snapshot' })
    const popover = container.querySelector('#browser-page-tools')!
    // A dialog hides the live page, which is drawn above the app; its picture takes its place.
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(container.querySelector('.browser-workspace-snapshot')).not.toBeNull()
    expect(request).toHaveBeenLastCalledWith({ conversationId: 'chat', action: 'unmount' })
    expect(popover.textContent).toContain('shop.example')
    expect(popover.textContent).toContain('offers the agent 2 tools')
    expect([...popover.querySelectorAll('code')].map((name) => name.textContent)).toEqual([
      'add_item',
      'get_cart'
    ])
    expect(popover.textContent).toContain('Read-only')
    // Descriptions stay out of sight until asked for.
    expect(popover.querySelector('blockquote')).toBeNull()
    expect(popover.textContent).not.toContain('an item')

    const row = popover.querySelector<HTMLButtonElement>('li button')!
    await act(async () => row.click())
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const description = popover.querySelector('blockquote')!
    expect(row.getAttribute('aria-controls')).toBe(description.id)
    // The site's words are text, never markup.
    expect(description.querySelector('b')).toBeNull()
    expect(description.textContent).toBe('<b>Adds</b> an item')

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(container.querySelector('#browser-page-tools')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
  it('closes the tools popover on a click outside it', async () => {
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      tabs: [
        { id: 'tab', title: 'Shop', url: 'https://shop.example/', active: true, loading: false }
      ],
      pageTools: {
        origin: 'https://shop.example',
        tools: [{ name: 'get_cart', description: 'Reads the cart', readOnly: true, form: false }]
      }
    })
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.browser-workspace-tools')!.click()
    )
    expect(container.querySelector('#browser-page-tools')?.textContent).toContain('1 tool')
    await act(async () =>
      container
        .querySelector('.browser-workspace-viewport')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }))
    )
    expect(container.querySelector('#browser-page-tools')).toBeNull()
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
