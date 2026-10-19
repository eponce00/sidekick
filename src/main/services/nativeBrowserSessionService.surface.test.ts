import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      getSize: () => ({ width: 1280, height: 900 }),
      resize: vi.fn(),
      toPNG: () => Buffer.from('fresh-frame')
    }))
  }
}))
import { mountBrowserView, parkBrowserView, registerBrowserView } from './browserViewHost'
import { ElectronNativeBrowserSurface } from './nativeBrowserSessionService'

let nextId = 950000

/**
 * A page whose native input waits in Chromium's input queue. Frame IPC reaches it at once, and
 * DevTools input commands join the same first-in, first-out queue as native input.
 */
function page() {
  let value = ''
  const queued: Array<() => void> = []
  const drain = (): void => {
    while (queued.length) queued.shift()!()
  }
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Input.insertText') {
      drain()
      value += String(params?.text)
    }
    return method === 'Page.captureScreenshot' ? { data: '' } : {}
  })
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getUserAgent: () => 'Chrome',
    invalidate: vi.fn(),
    capturePage: vi.fn(async () => ({ getSize: () => ({ width: 460, height: 600 }) })),
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 900 })),
    sendInputEvent: vi.fn((event: { type: string; keyCode?: string }) => {
      queued.push(() => {
        if (event.type === 'keyDown' && event.keyCode === 'Backspace') value = value.slice(0, -1)
      })
    }),
    insertText: vi.fn(async (text: string) => {
      value += text
    }),
    debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand })
  })
  return { contents, sendCommand, drain, value: () => value }
}

it('inserts text behind the keys that cleared the field', async () => {
  const fake = page()
  const surface = new ElectronNativeBrowserSurface(
    fake.contents as unknown as WebContents,
    null,
    true
  )
  surface.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  surface.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  await surface.insertText('native-token')
  // A Backspace still queued after the text would delete its last character.
  fake.drain()
  expect(fake.value()).toBe('native-token')
  expect(fake.contents.insertText).not.toHaveBeenCalled()
})

it('screenshots a parked agent viewport from a fresh frame, not the panel’s last one', async () => {
  const fake = page()
  const windowParts = () => ({
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    on: vi.fn(),
    once: vi.fn()
  })
  const parking = Object.assign(windowParts(), {
    getContentSize: () => [1280, 900],
    setOpacity: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    capturePage: vi.fn(async () => undefined)
  })
  const view = {
    webContents: fake.contents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    getBounds: () => ({ x: 20, y: 80, width: 460, height: 600 })
  }
  try {
    const surface = new ElectronNativeBrowserSurface(
      fake.contents as unknown as WebContents,
      parking as unknown as BrowserWindow,
      false,
      view as unknown as WebContentsView
    )
    registerBrowserView(view as unknown as WebContentsView, parking as unknown as BrowserWindow)
    const host = windowParts() as unknown as BrowserWindow
    mountBrowserView(fake.contents.id, host, { x: 20, y: 80, width: 460, height: 600 }, () => true)
    await surface.setAgentViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })

    // Parked, the page is back at full scale, so it no longer looks scaled to the capture.
    parkBrowserView(fake.contents.id)
    const capture = await surface.captureViewport()

    expect(fake.contents.capturePage).not.toHaveBeenCalled()
    const methods = fake.sendCommand.mock.calls.map(([method]) => method)
    expect(methods.slice(-2)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Page.captureScreenshot'
    ])
    expect(fake.sendCommand).toHaveBeenLastCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({
        fromSurface: true,
        clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 }
      })
    )
    expect([capture.width, capture.height]).toEqual([1280, 900])
  } finally {
    fake.contents.emit('destroyed')
  }
})
