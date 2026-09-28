import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const window = { isDestroyed: vi.fn(() => false), setOverlayIcon: vi.fn() }
  return {
    window,
    app: { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn() },
    createFromBitmap: vi.fn((buffer: Buffer) => ({ buffer }))
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: { getAllWindows: () => [electron.window] },
  nativeImage: { createFromBitmap: electron.createFromBitmap }
}))

import {
  applyAttentionBadge,
  attentionBadgeBitmap,
  attentionBadgeLabel,
  refreshAttentionBadge
} from './attentionBadge'

function pixel(buffer: Buffer, x: number, y: number): number[] {
  const offset = (y * 32 + x) * 4
  return [...buffer.subarray(offset, offset + 4)]
}

describe('attention badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    applyAttentionBadge(0, 'linux')
    vi.clearAllMocks()
  })

  it('caps the label at 9+', () => {
    expect(attentionBadgeLabel(3)).toBe('3')
    expect(attentionBadgeLabel(10)).toBe('9+')
  })

  it('draws a disc with a light glyph and transparent corners', () => {
    const bitmap = attentionBadgeBitmap(1)
    expect(bitmap).toHaveLength(32 * 32 * 4)
    expect(pixel(bitmap, 0, 0)[3]).toBe(0)
    expect(pixel(bitmap, 4, 16)[3]).toBe(255)
    // The top of the "1" sits in the middle column of the glyph.
    expect(pixel(bitmap, 16, 7)).toEqual([255, 255, 255, 255])
  })

  it('sets and clears a Windows taskbar overlay', () => {
    applyAttentionBadge(2, 'win32')
    expect(electron.createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), {
      width: 32,
      height: 32,
      scaleFactor: 2
    })
    expect(electron.window.setOverlayIcon).toHaveBeenLastCalledWith(
      expect.anything(),
      '2 conversations are waiting for you'
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
      '1 conversation is waiting for you'
    )
  })
})
