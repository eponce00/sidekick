import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sender: { mainFrame: {} },
  create: vi.fn(async () => ({ id: 'shell' })),
  write: vi.fn(() => true)
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('./state', () => ({
  appState: { mainWindowRef: { webContents: mocks.sender } },
  getDb: () => ({})
}))
vi.mock('../bootstrap/panelWindows', () => ({ panelWindowFor: () => undefined }))
vi.mock('../services/projectStore', () => ({ ProjectStore: class {} }))
vi.mock('../services/userTerminals', () => ({
  UserTerminalService: class {
    create = mocks.create
    write = mocks.write
  }
}))
import { registerUserTerminalHandlers } from './userTerminals'

describe('user terminal IPC', () => {
  it('opens and types into a shell only for the app window, never a web page or subframe', async () => {
    registerUserTerminalHandlers()
    const create = mocks.handlers.get('userTerminal:create')!
    const write = mocks.handlers.get('userTerminal:write')!
    const page = { sender: {}, senderFrame: {} }
    const subframe = { sender: mocks.sender, senderFrame: {} }
    for (const event of [page, subframe]) {
      expect(() => create(event, { conversationId: 'chat' })).toThrow(/only available/)
      expect(() => write(event, 'shell', 'whoami\r')).toThrow(/only available/)
    }
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()

    const app = { sender: mocks.sender, senderFrame: mocks.sender.mainFrame }
    // The window names a chat, never a folder: the service finds the folder itself.
    await create(app, { conversationId: 'chat', cwd: 'C:\\Windows', cols: 80, rows: 24 })
    expect(mocks.create).toHaveBeenCalledWith({ conversationId: 'chat', cols: 80, rows: 24 })
    expect(write(app, 'shell', 'whoami\r')).toEqual({ written: true })
  })
})
