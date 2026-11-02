import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  nativeImage: {},
  screen: { screenToDipPoint: (point: { x: number; y: number }) => point }
}))
vi.mock('../ipc/state', () => ({ appState: { mainWindowRef: null, store: null } }))

import { ComputerUseHighlight } from './computerUseHighlight'

describe('ComputerUseHighlight', () => {
  it('lets a step go on when the glide it waits for is cut short', async () => {
    const highlight = new ComputerUseHighlight()
    const cursor = {
      isDestroyed: () => false,
      isVisible: () => true,
      setBounds: vi.fn(),
      destroy: vi.fn(),
      webContents: { executeJavaScript: async () => undefined }
    }
    Object.assign(highlight, {
      target: { appName: 'App', visible: async () => true, bounds: async () => null },
      mode: 'glow',
      cursor,
      cursorAt: { x: 0, y: 0 }
    })
    const arrived = highlight.moveCursor({ x: 500, y: 500 })
    await Promise.resolve()
    highlight.hide()
    await expect(
      Promise.race([
        arrived.then(() => 'arrived'),
        new Promise((resolve) => setTimeout(() => resolve('stuck'), 50))
      ])
    ).resolves.toBe('arrived')
  })
})
