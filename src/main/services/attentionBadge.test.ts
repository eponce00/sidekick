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

import { applyAttentionBadge, attentionDotBitmap, refreshAttentionBadge } from './attentionBadge'

function pixel(buffer: Buffer, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4
  return [...buffer.subarray(offset, offset + 4)]
}

describe('attention badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electron.createEmpty.mockReturnValue(electron.image)
    applyAttentionBadge(0, 'linux')
    vi.clearAllMocks()
    electron.createEmpty.mockReturnValue(electron.image)
  })

  it('draws a small accent dot in a dark ring with smooth, transparent edges', () => {
    const size = 48
    const bitmap = attentionDotBitmap(size)
    expect(bitmap).toHaveLength(size * size * 4)
    expect(pixel(bitmap, size, 0, 0)[3]).toBe(0)
    expect(pixel(bitmap, size, size - 1, size - 1)[3]).toBe(0)
    // The accent at the centre, the ring just inside the edge, and partial coverage at the edge.
    expect(pixel(bitmap, size, 24, 24)).toEqual([0xbd, 0xd4, 0x3b, 255])
    expect(pixel(bitmap, size, 24, 7)).toEqual([0x14, 0x11, 0x0f, 255])
    const edgeAlphas = Array.from({ length: size }, (_, x) => pixel(bitmap, size, x, 24)[3])
    expect(edgeAlphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true)
  })

  it('sets a Windows overlay drawn for every display scale, and clears it', () => {
    applyAttentionBadge(2, 'win32')
    const sizes = electron.image.addRepresentation.mock.calls.map(([options]) => [
      options.scaleFactor,
      options.width
    ])
    expect(sizes).toEqual([
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32],
      [2.5, 40],
      [3, 48],
      [4, 64]
    ])
    expect(electron.window.setOverlayIcon).toHaveBeenLastCalledWith(
      electron.image,
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
