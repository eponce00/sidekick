import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const window = { isDestroyed: vi.fn(() => false), setOverlayIcon: vi.fn() }
  return {
    window,
    app: { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn() },
    image: { addRepresentation: vi.fn() },
    createEmpty: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: { getAllWindows: () => [electron.window] },
  nativeImage: { createEmpty: electron.createEmpty }
}))

import { applyAttentionBadge, refreshAttentionBadge } from './attentionBadge'

describe('attention badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.createEmpty.mockReturnValue(electron.image)
    applyAttentionBadge(0, 'linux')
    vi.clearAllMocks()
    electron.createEmpty.mockReturnValue(electron.image)
  })

  it('sets a Windows overlay, and clears it', () => {
    applyAttentionBadge(2, 'win32')
    expect(electron.window.setOverlayIcon).toHaveBeenLastCalledWith(
      electron.image,
      expect.any(String)
    )
    applyAttentionBadge(0, 'win32')
    expect(electron.window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
  })

  it('uses the Dock badge on macOS and the launcher count on Linux', () => {
    applyAttentionBadge(4, 'darwin')
    expect(electron.app.dock.setBadge).toHaveBeenLastCalledWith('4')
    applyAttentionBadge(0, 'darwin')
    expect(electron.app.dock.setBadge).toHaveBeenLastCalledWith('')
    applyAttentionBadge(3, 'linux')
    expect(electron.app.setBadgeCount).toHaveBeenLastCalledWith(3)
  })

  it('reapplies the current badge for a new window only while something is waiting', () => {
    refreshAttentionBadge('win32')
    expect(electron.window.setOverlayIcon).not.toHaveBeenCalled()
    applyAttentionBadge(1, 'win32')
    electron.window.setOverlayIcon.mockClear()
    refreshAttentionBadge('win32')
    expect(electron.window.setOverlayIcon).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String)
    )
  })
})
