import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateService } from '../services/appUpdateService'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  sender: { mainFrame: {} }
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (name: string, handler: (event: unknown) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('./state', () => ({ appState: { mainWindowRef: { webContents: mocks.sender } } }))
import { registerAppUpdateHandlers } from './appUpdates'

describe('update installation IPC', () => {
  it('rejects native browser pages and subframes, accepting only the application main frame', () => {
    const install = vi.fn()
    registerAppUpdateHandlers({
      install,
      subscribe: () => () => undefined
    } as unknown as AppUpdateService)
    const handler = mocks.handlers.get('appUpdates:install')!
    expect(() => handler({ sender: {}, senderFrame: {} })).toThrow(/Only/)
    expect(() => handler({ sender: mocks.sender, senderFrame: {} })).toThrow(/Only/)
    expect(install).not.toHaveBeenCalled()
    handler({ sender: mocks.sender, senderFrame: mocks.sender.mainFrame })
    expect(install).toHaveBeenCalledOnce()
  })
})
