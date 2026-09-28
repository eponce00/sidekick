import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContentsView } from 'electron'
import { expect, it, vi } from 'vitest'
const menu = vi.hoisted(() => ({ buildFromTemplate: vi.fn() }))
const overlays = vi.hoisted(() => [] as Array<Record<string, ReturnType<typeof vi.fn>>>)
vi.mock('electron', () => ({
  Menu: menu,
  WebContentsView: vi.fn(function () {
    const overlay = {
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
      setBounds: vi.fn(),
      webContents: {
        isDestroyed: () => false,
        loadURL: vi.fn(async () => undefined),
        executeJavaScript: vi.fn(async () => undefined),
        close: vi.fn()
      }
    }
    overlays.push(overlay as never)
    return overlay
  })
}))
import {
  browserAgentInput,
  browserDebuggerCommand,
  mountBrowserView,
  parkBrowserView,
  registerBrowserView,
  showBrowserPointer
} from './browserViewHost'

let nextId = 900000
function hosted(zoom?: number) {
  let zoomFactor = 1
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    isDestroyed: vi.fn(() => false),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    getZoomFactor: vi.fn(() => zoomFactor),
    setZoomFactor: vi.fn((value: number) => {
      zoomFactor = value
    })
  })
  const view = {
    webContents: contents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    getBounds: () => ({ x: 200, y: 50, width: 100, height: 100 })
  }
  const parking = {
    isDestroyed: () => false,
    contentView: { removeChildView: vi.fn(), addChildView: vi.fn() },
    getContentSize: () => [100, 100],
    setOpacity: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn()
  }
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  })
  const allowInput = vi.fn(() => false)
  registerBrowserView(view as unknown as WebContentsView, parking as unknown as BrowserWindow)
  mountBrowserView(
    contents.id,
    host as unknown as BrowserWindow,
    { x: 0, y: 0, width: 100, height: 100 },
    allowInput,
    zoom
  )
  const input = () => {
    const event = { preventDefault: vi.fn() }
    contents.emit('before-input-event', event)
    contents.emit('before-mouse-event', event, { type: 'mouseDown' })
    return event
  }
  return { contents, allowInput, input, host }
}

it('floats the agent cursor above the shown page at the zoomed point, and hides it on park', async () => {
  const { contents, host } = hosted(0.5)
  overlays.length = 0
  // CSS (40, 60) at half zoom is 20, 30 into a page placed at (200, 50).
  await showBrowserPointer(contents.id, 40, 60)
  const [overlay] = overlays
  expect(host.contentView.addChildView).toHaveBeenLastCalledWith(overlay)
  expect(overlay.setBounds).toHaveBeenLastCalledWith({ x: 180, y: 40, width: 96, height: 96 })
  expect(overlay.setVisible).toHaveBeenLastCalledWith(true)

  // A point beyond the page is not drawn over the app around it.
  overlay.setBounds.mockClear()
  await showBrowserPointer(contents.id, 400, 60)
  expect(overlay.setBounds).not.toHaveBeenCalled()

  parkBrowserView(contents.id)
  expect(overlay.setVisible).toHaveBeenLastCalledWith(false)
  await showBrowserPointer(contents.id, 40, 60)
  expect(overlay.setVisible).toHaveBeenLastCalledWith(false)
})

it.each(['cut', 'copy', 'paste', 'selectAll'] as const)(
  'rechecks current ownership before a previously opened menu can %s',
  async (action) => {
    const fixture = hosted()
    const popup = vi.fn()
    menu.buildFromTemplate.mockReset().mockReturnValue({ popup })
    fixture.allowInput.mockReturnValue(true)
    const handler = fixture.contents.listeners('context-menu')[0]
    try {
      await handler(
        {},
        { editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }
      )
      expect(popup).toHaveBeenCalledTimes(1)
      const index = { cut: 0, copy: 1, paste: 2, selectAll: 4 }[action]
      const item = menu.buildFromTemplate.mock.calls[0][0][index]
      fixture.allowInput.mockReturnValue(false)
      item.click()
      expect(fixture.contents[action]).not.toHaveBeenCalled()
      fixture.allowInput.mockReturnValue(true)
      item.click()
      expect(fixture.contents[action]).toHaveBeenCalledTimes(1)
      fixture.contents.isDestroyed.mockReturnValue(true)
      item.click()
      expect(fixture.contents[action]).toHaveBeenCalledTimes(1)
      fixture.contents.isDestroyed.mockReturnValue(false)
      fixture.contents.emit('destroyed')
      item.click()
      expect(fixture.contents[action]).toHaveBeenCalledTimes(1)
    } finally {
      fixture.contents.emit('destroyed')
    }
  }
)

it('does not publish a menu if ownership changes during the asynchronous import', async () => {
  const fixture = hosted()
  menu.buildFromTemplate.mockReset().mockReturnValue({ popup: vi.fn() })
  fixture.allowInput.mockReturnValue(true)
  const handler = fixture.contents.listeners('context-menu')[0]
  try {
    const pending = handler({}, { editFlags: {} })
    fixture.allowInput.mockReturnValue(false)
    await pending
    expect(menu.buildFromTemplate).not.toHaveBeenCalled()
  } finally {
    fixture.contents.emit('destroyed')
  }
})

it.each([
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject'
])('keeps real user input gated while %s is pending', async (method) => {
  const fixture = hosted()
  let finish!: () => void
  const pending = browserDebuggerCommand(
    fixture.contents.id,
    method,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  try {
    expect(fixture.input().preventDefault).toHaveBeenCalledTimes(2)
    expect(fixture.allowInput).toHaveBeenCalledTimes(2)
  } finally {
    finish()
    await pending
    fixture.contents.emit('destroyed')
  }
})

it.each(['native', 'Input.dispatchKeyEvent'])(
  'preserves the bounded exemption for %s gestures',
  async (kind) => {
    const fixture = hosted()
    let finish!: () => void
    const operation = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const pending =
      kind === 'native'
        ? browserAgentInput(fixture.contents.id, operation)
        : browserDebuggerCommand(fixture.contents.id, kind, operation)
    try {
      expect(fixture.input().preventDefault).not.toHaveBeenCalled()
      expect(fixture.allowInput).not.toHaveBeenCalled()
      finish()
      await pending
      expect(fixture.input().preventDefault).toHaveBeenCalledTimes(2)
      expect(fixture.allowInput).toHaveBeenCalledTimes(2)
    } finally {
      finish()
      await pending
      fixture.contents.emit('destroyed')
    }
  }
)

it('restores human input checks after an injected input command fails', async () => {
  const fixture = hosted()
  try {
    await expect(
      browserDebuggerCommand(fixture.contents.id, 'Input.insertText', async () => {
        throw new Error('injection failed')
      })
    ).rejects.toThrow('injection failed')
    expect(fixture.input().preventDefault).toHaveBeenCalledTimes(2)
  } finally {
    fixture.contents.emit('destroyed')
  }
})

it('renders an embedded page at the host app zoom instead of natural scale', () => {
  const fixture = hosted(0.8)
  try {
    expect(fixture.contents.setZoomFactor).toHaveBeenCalledWith(0.8)
    expect(fixture.contents.getZoomFactor()).toBe(0.8)
  } finally {
    fixture.contents.emit('destroyed')
  }
})

it('reapplies the host zoom after a cross-origin navigation resets it', () => {
  const fixture = hosted(0.8)
  try {
    fixture.contents.setZoomFactor(1)
    fixture.contents.emit('did-navigate')
    expect(fixture.contents.getZoomFactor()).toBe(0.8)
  } finally {
    fixture.contents.emit('destroyed')
  }
})

it('returns a parked view to natural scale so automation sizing is unaffected', () => {
  const fixture = hosted(0.8)
  try {
    parkBrowserView(fixture.contents.id)
    expect(fixture.contents.getZoomFactor()).toBe(1)
  } finally {
    fixture.contents.emit('destroyed')
  }
})
