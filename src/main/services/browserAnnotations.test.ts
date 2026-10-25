import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { MAX_BROWSER_ANNOTATIONS } from '../../shared/browserWorkspace'
import {
  BrowserAnnotationController,
  safeAccent,
  withPageTimeout,
  type BrowserAnnotationPage
} from './browserAnnotations'
import type {
  BrowserAnnotationOverlayHandle,
  BrowserAnnotationOverlayInput,
  BrowserAnnotationOverlayState
} from './browserAnnotationOverlay'

function fakeHost(): BrowserWindow {
  return { once: vi.fn(), isDestroyed: () => false } as unknown as BrowserWindow
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve))
}

/** A page with a button at 10,20 100×32 and a password field at 10,80 200×30. */
function setup(options: { secretShown?: boolean; scale?: number } = {}) {
  const host = fakeHost()
  const scale = options.scale ?? 1
  const calls: string[] = []
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push(method)
    switch (method) {
      case 'Page.getLayoutMetrics':
        return {
          cssVisualViewport: { pageX: 0, pageY: page.scrollY, clientWidth: 400, clientHeight: 300 }
        }
      case 'DOM.getNodeForLocation': {
        const { x, y } = params as { x: number; y: number }
        if (x >= 10 && x <= 110 && y >= 20 && y <= 52) return { backendNodeId: 7 }
        if (x >= 10 && x <= 210 && y >= 80 && y <= 110) return { backendNodeId: 9 }
        return { backendNodeId: 1 }
      }
      case 'DOM.describeNode': {
        const id = (params as { backendNodeId: number }).backendNodeId
        return { node: nodes[id] }
      }
      case 'DOM.getBoxModel': {
        const id = (params as { backendNodeId: number }).backendNodeId
        const box = boxes[id]
        if (!box) throw new Error('No node')
        const [x, y, w, h] = box
        return { model: { border: [x, y, x + w, y, x + w, y + h, x, y + h] } }
      }
      case 'DOM.getDocument':
        return { root: document }
      case 'Accessibility.getPartialAXTree': {
        const id = (params as { backendNodeId: number }).backendNodeId
        return {
          nodes: [
            id === 7
              ? { backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Sign in' } }
              : { backendDOMNodeId: id, role: { value: 'generic' } }
          ]
        }
      }
      case 'Page.captureScreenshot':
        // No pixels in this test; the picture pipeline has its own tests.
        return {}
      default:
        throw new Error(`Unexpected ${method}`)
    }
  })
  const nodes: Record<number, unknown> = {
    1: { backendNodeId: 1, nodeType: 1, nodeName: 'BODY', localName: 'body', children: [] },
    7: {
      backendNodeId: 7,
      nodeType: 1,
      nodeName: 'BUTTON',
      localName: 'button',
      attributes: ['id', 'login'],
      children: []
    },
    9: {
      backendNodeId: 9,
      nodeType: 1,
      nodeName: 'INPUT',
      localName: 'input',
      attributes: ['type', 'password'],
      children: []
    }
  }
  const boxes: Record<number, [number, number, number, number]> = {
    1: [0, 0, 400, 300],
    7: [10, 20, 100, 32],
    9: [10, 80, 200, 30]
  }
  const document = {
    backendNodeId: 100,
    nodeType: 9,
    nodeName: '#document',
    children: [
      {
        backendNodeId: 101,
        nodeType: 1,
        nodeName: 'HTML',
        localName: 'html',
        children: [
          {
            ...(nodes[1] as object),
            children: [
              {
                ...(nodes[7] as object),
                children: [
                  { backendNodeId: 8, nodeType: 3, nodeName: '#text', nodeValue: 'Sign in' }
                ]
              },
              nodes[9]
            ]
          }
        ]
      }
    ]
  }
  const page = {
    scrollY: 0,
    current: {
      tabId: 'tab',
      webContentsId: 42,
      url: 'https://user:pass@shop.example/login',
      title: 'Sign in',
      send,
      secretShownAsText: vi.fn(async () => Boolean(options.secretShown))
    } as BrowserAnnotationPage
  }
  const rendered: BrowserAnnotationOverlayState[] = []
  let onInput: ((input: BrowserAnnotationOverlayInput) => void) | undefined
  const overlay: BrowserAnnotationOverlayHandle & { placed: unknown[] } = {
    visible: false,
    placed: [],
    place(bounds) {
      this.placed.push(bounds)
      ;(this as { visible: boolean }).visible = true
    },
    hide() {
      ;(this as { visible: boolean }).visible = false
    },
    render: (state) => rendered.push(state)
  }
  const notify = vi.fn()
  const scroll = vi.fn()
  const controller = new BrowserAnnotationController({
    page: () => page.current,
    placement: (id) =>
      id === 42 ? { host, bounds: { x: 300, y: 80, width: 400, height: 300 }, scale } : undefined,
    overlay: async (_host, listener) => {
      onInput = listener
      return overlay
    },
    scroll,
    notify
  })
  const input = (event: BrowserAnnotationOverlayInput): void => onInput!(event)
  const click = async (x: number, y: number): Promise<void> => {
    input({ type: 'pointer', kind: 'down', x, y })
    input({ type: 'pointer', kind: 'up', x, y })
    await flush()
  }
  return { host, controller, overlay, rendered, notify, scroll, input, click, page, calls, send }
}

async function annotating(context: ReturnType<typeof setup>): Promise<void> {
  context.controller.setAnnotating('chat', true, { accent: '#2850b8', accentText: '#ffffff' })
  await context.controller.sync(context.host, 'chat', 42)
  await flush()
}

describe('browser annotations', () => {
  it('covers the page only while annotating, in the app accent', async () => {
    const context = setup()
    await context.controller.sync(context.host, 'chat', 42)
    expect(context.overlay.visible).toBe(false)
    await annotating(context)
    expect(context.overlay.visible).toBe(true)
    expect(context.overlay.placed.at(-1)).toEqual({ x: 300, y: 80, width: 400, height: 300 })
    expect(context.rendered.at(-1)).toMatchObject({ accent: '#2850b8', accentText: '#ffffff' })
    context.input({ type: 'stop' })
    await flush()
    expect(context.overlay.visible).toBe(false)
    expect(context.controller.panelState('chat').annotating).toBe(false)
  })

  it('marks the element clicked with what Chromium says it is, and numbers it on the page', async () => {
    const context = setup({ scale: 0.5 })
    await annotating(context)
    // At half scale, overlay point 30,60 is CSS point 60,120... outside; 30,20 is 60,40 in the button.
    await context.click(30, 20)
    const [mark] = context.controller.list('chat')
    expect(mark).toMatchObject({
      kind: 'browser',
      number: 1,
      name: 'Button “Sign in”',
      note: '',
      // A user name and password in the address are never sent.
      url: 'https://shop.example/login',
      title: 'Sign in',
      target: 'element',
      selector: '#login',
      role: 'button',
      accessibleName: 'Sign in',
      box: { x: 10, y: 20, width: 100, height: 32 },
      viewport: { width: 400, height: 300 }
    })
    expect(context.notify).toHaveBeenCalledWith({ conversationId: 'chat' })
    // Drawn at the page's scale in the overlay, with its number.
    expect(context.rendered.at(-1)?.marks).toMatchObject([
      { x: 5, y: 10, width: 50, height: 16, number: 1, area: false }
    ])
    // Its note opens on the page.
    expect(context.rendered.at(-1)?.editing).toBe(mark.id)
    expect(context.controller.panelState('chat').annotations).toEqual([
      {
        id: mark.id,
        number: 1,
        name: 'Button “Sign in”',
        note: '',
        target: 'element',
        onPage: true
      }
    ])
    // Nothing ran in the page to make it.
    expect(context.calls.some((method) => method.startsWith('Runtime.'))).toBe(false)
  })

  it('marks a dragged area, which moves with the page as it scrolls', async () => {
    const context = setup()
    await annotating(context)
    context.input({ type: 'pointer', kind: 'down', x: 150, y: 150 })
    context.input({ type: 'pointer', kind: 'move', x: 160, y: 160 })
    await flush()
    expect(context.rendered.at(-1)?.drag).toEqual({ x: 150, y: 150, width: 10, height: 10 })
    context.input({ type: 'pointer', kind: 'move', x: 250, y: 200 })
    context.input({ type: 'pointer', kind: 'up', x: 250, y: 200 })
    await flush()
    const [mark] = context.controller.list('chat')
    expect(mark).toMatchObject({
      target: 'area',
      name: 'Area 100 × 50',
      box: { x: 150, y: 150, width: 100, height: 50 }
    })
    context.page.scrollY = 40
    context.input({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: -120 })
    expect(context.scroll).toHaveBeenCalledWith('chat', 42, {
      type: 'wheel',
      x: 200,
      y: 200,
      deltaX: 0,
      deltaY: -120
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await flush()
    expect(context.rendered.at(-1)?.marks).toMatchObject([
      { x: 150, y: 110, width: 100, height: 50, number: 1, area: true }
    ])
  })

  it('ignores a drag too small to be an area and a click on nothing it can read', async () => {
    const context = setup()
    await annotating(context)
    context.input({ type: 'pointer', kind: 'down', x: 150, y: 150 })
    context.input({ type: 'pointer', kind: 'move', x: 156, y: 153 })
    context.input({ type: 'pointer', kind: 'up', x: 156, y: 153 })
    await flush()
    expect(context.controller.list('chat')).toEqual([])
  })

  it('takes no picture while a stored password is shown as text', async () => {
    const context = setup({ secretShown: true })
    await annotating(context)
    await context.click(20, 30)
    const [mark] = context.controller.list('chat')
    expect(mark.image).toBeUndefined()
    expect(context.calls).not.toContain('Page.captureScreenshot')
  })

  it('drops a mark whose page changed while it was being read', async () => {
    const context = setup()
    await annotating(context)
    const original = context.page.current.send
    context.page.current.send = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument')
        context.page.current = { ...context.page.current, webContentsId: 43 }
      return original(method, params)
    }) as never
    await context.click(20, 30)
    expect(context.controller.list('chat')).toEqual([])
  })

  it('keeps at most the marks one message can carry, and renumbers when one goes', async () => {
    const context = setup()
    await annotating(context)
    for (let index = 0; index <= MAX_BROWSER_ANNOTATIONS; index++) await context.click(20, 30)
    expect(context.controller.list('chat')).toHaveLength(MAX_BROWSER_ANNOTATIONS)
    expect(context.notify).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('up to 8 places') })
    )
    const [first, second, third] = context.controller.list('chat')
    context.controller.remove('chat', second.id)
    expect(context.controller.list('chat').map((mark) => [mark.id, mark.number])).toEqual(
      [first, third, ...context.controller.list('chat').slice(2)].map((mark, index) => [
        mark.id,
        index + 1
      ])
    )
    context.controller.setNote('chat', first.id, `a\r\nb${'x'.repeat(3_000)}`)
    expect(context.controller.list('chat')[0].note).toHaveLength(2_000)
    expect(context.controller.list('chat')[0].note.startsWith('a\nb')).toBe(true)

    const taken = context.controller.take('chat', [first.id, third.id, 'unknown'])
    expect(taken.map((mark) => mark.id)).toEqual([first.id, third.id])
    expect(context.controller.list('chat').map((mark) => mark.number)).toEqual(
      Array.from({ length: MAX_BROWSER_ANNOTATIONS - 3 }, (_, index) => index + 1)
    )
    expect(() => context.controller.setNote('chat', first.id, 'gone')).toThrow(
      'no longer on the page'
    )
  })

  it('does nothing with input while not annotating, and draws only marks on the page shown', async () => {
    const context = setup()
    await annotating(context)
    await context.click(20, 30)
    context.page.current = { ...context.page.current, url: 'https://shop.example/cart' }
    expect(context.controller.panelState('chat').annotations[0].onPage).toBe(false)
    await context.controller.sync(context.host, 'chat', 42)
    await flush()
    expect(context.rendered.at(-1)?.marks).toEqual([])
    context.controller.setAnnotating('chat', false)
    await context.click(20, 30)
    expect(context.controller.list('chat')).toHaveLength(1)
  })

  it('lets only a plain color into the overlay', () => {
    expect(safeAccent('#86aee8')).toBe('#86aee8')
    expect(safeAccent(' rgb(40, 80, 184) ')).toBe('rgb(40, 80, 184)')
    expect(safeAccent('red;}body{background:url(https://evil.example)')).toBeUndefined()
    expect(safeAccent('var(--accent)')).toBeUndefined()
    expect(safeAccent(42)).toBeUndefined()
  })
})

describe('page calls while annotating', () => {
  it('give up on a page that does not answer, so marking never waits on it for good', async () => {
    vi.useFakeTimers()
    try {
      const send = withPageTimeout(() => new Promise<never>(() => undefined), 5_000)
      const call = send('DOM.getNodeForLocation', { x: 1, y: 1 })
      const settled = expect(call).rejects.toThrow('did not answer in time')
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('pass answers and errors through untouched', async () => {
    await expect(withPageTimeout(async <T>() => ({ ok: true }) as T)('X')).resolves.toEqual({
      ok: true
    })
    await expect(
      withPageTimeout(async () => {
        throw new Error('detached')
      })('X')
    ).rejects.toThrow('detached')
  })
})
