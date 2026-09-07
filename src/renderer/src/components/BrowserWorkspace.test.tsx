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
      userControl: true,
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
      userControl: false,
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
  it('keeps verification completion on its dedicated handoff card', async () => {
    request.mockResolvedValue({
      sessionId: 'session',
      activeTabId: 'tab',
      busy: false,
      userControl: true,
      verificationHandoff: true,
      tabs: []
    })
    await act(async () => root.render(<BrowserWorkspace conversationId="chat" />))
    expect(container.querySelector('[aria-label*="conversation handoff card"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Resume agent')
  })
})
