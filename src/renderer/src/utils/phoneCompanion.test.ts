import { describe, expect, it } from 'vitest'
import {
  companionErrorMessage,
  deviceActivity,
  formatCountdown,
  phonePopoverPosition,
  qrPixelSize,
  qrRects,
  qrUnits
} from './phoneCompanion'

describe('qrRects', () => {
  it('merges each row’s dark runs into rects offset by the quiet zone', () => {
    const modules = [
      [true, true, false, true],
      [false, false, false, false],
      [true, true, true, true]
    ]
    expect(qrRects(modules)).toEqual([
      { x: 4, y: 4, width: 2 },
      { x: 7, y: 4, width: 1 },
      { x: 4, y: 6, width: 4 }
    ])
  })

  it('closes a run that reaches the end of its row', () => {
    expect(qrRects([[false, true, true]], 0)).toEqual([{ x: 1, y: 0, width: 2 }])
  })

  it('draws nothing for a blank code', () => {
    expect(qrRects([[false, false]])).toEqual([])
    expect(qrRects([])).toEqual([])
  })
})

describe('qrUnits and qrPixelSize', () => {
  it('adds the quiet zone on both sides', () => {
    expect(qrUnits(Array.from({ length: 25 }, () => []))).toBe(33)
  })

  it('uses a whole number of pixels per module', () => {
    expect(qrPixelSize(33)).toBe(165)
    expect(qrPixelSize(37)).toBe(148)
    expect(qrPixelSize(49)).toBe(147)
    expect(qrPixelSize(0)).toBe(0)
  })

  it('keeps at least two pixels per module for very large codes', () => {
    expect(qrPixelSize(185)).toBe(370)
  })
})

describe('formatCountdown', () => {
  it('shows minutes and padded seconds', () => {
    expect(formatCountdown(102_000)).toBe('1:42')
    expect(formatCountdown(9_000)).toBe('0:09')
  })

  it('rounds a partial second up, so a code never reads 0:00 while it still works', () => {
    expect(formatCountdown(400)).toBe('0:01')
  })

  it('never goes negative', () => {
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('deviceActivity', () => {
  const now = Date.UTC(2026, 9, 23, 12)

  it('says a connected phone is connected', () => {
    expect(
      deviceActivity({ connected: true, lastSeenAt: now - 86_400_000, createdAt: 0 }, now)
    ).toBe('Connected')
  })

  it('says when a phone was last used', () => {
    expect(deviceActivity({ connected: false, lastSeenAt: now - 20_000, createdAt: 0 }, now)).toBe(
      'Just now'
    )
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 5 * 60_000, createdAt: 0 }, now)
    ).toBe('5 min ago')
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 3 * 3_600_000, createdAt: 0 }, now)
    ).toBe('3 h ago')
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 2 * 86_400_000, createdAt: 0 }, now)
    ).toBe('2 d ago')
  })

  it('falls back to when it was paired', () => {
    expect(
      deviceActivity({ connected: false, lastSeenAt: null, createdAt: now - 10 * 60_000 }, now)
    ).toBe('10 min ago')
  })
})

describe('phonePopoverPosition', () => {
  const viewport = { width: 1200, height: 800 }
  const button = { left: 10, right: 39, top: 760, bottom: 789 }

  it('opens above the button in the full sidebar, starting at its left edge', () => {
    expect(phonePopoverPosition(button, 'above', viewport)).toEqual({
      left: 10,
      bottom: 46,
      maxHeight: 746
    })
  })

  it('opens beside the button in the rail, level with its bottom', () => {
    expect(phonePopoverPosition(button, 'beside', viewport)).toEqual({
      left: 46,
      bottom: 11,
      maxHeight: 781
    })
  })

  it('stays inside a narrow window', () => {
    expect(
      phonePopoverPosition({ left: 300, right: 329, top: 2, bottom: 31 }, 'beside', {
        width: 400,
        height: 30
      })
    ).toEqual({ left: 72, bottom: 8, maxHeight: 14 })
  })
})

describe('companionErrorMessage', () => {
  it('drops the prefix Electron adds to errors from the main process', () => {
    expect(
      companionErrorMessage(
        new Error("Error invoking remote method 'companion:setEnabled': Error: No Wi-Fi network")
      )
    ).toBe('No Wi-Fi network')
  })
})
