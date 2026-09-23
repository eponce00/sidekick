import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  show: vi.fn(),
  send: vi.fn(),
  window: null as null | Record<string, unknown>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    on: vi.fn()
  },
  clipboard: { writeText: vi.fn() },
  BrowserWindow: { fromWebContents: () => mocks.window },
  Notification: class {
    static isSupported = (): boolean => true
    on(event: string, listener: (...args: unknown[]) => void): this {
      mocks.listeners.set(event, listener)
      return this
    }
    show = mocks.show
  }
}))
vi.mock('fs', () => ({ readFileSync: () => Buffer.from('') }))
vi.mock('../../../resources/icon.png?asset', () => ({ default: 'icon.png' }))

import { registerWindowHandlers } from './window'

describe('notification:show', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.listeners.clear()
    mocks.show.mockReset()
    mocks.send.mockReset()
    mocks.window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: mocks.send }
    }
    registerWindowHandlers()
  })

  it('opens the conversation that finished when the notification is clicked', async () => {
    const show = mocks.handlers.get('notification:show') as Handler
    await show({ sender: {} }, { body: 'Done', silent: true, conversationId: 'conv-7' })

    mocks.listeners.get('click')?.()

    expect(mocks.window?.focus).toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith('app:openConversation', 'conv-7')
  })

  it('only focuses the window when no conversation is attached', async () => {
    const show = mocks.handlers.get('notification:show') as Handler
    await show({ sender: {} }, { body: 'Done', silent: true })

    mocks.listeners.get('click')?.()

    expect(mocks.window?.focus).toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
