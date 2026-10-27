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

describe('the pairing code', () => {
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
    expect(qrRects([[false, false]])).toEqual([])
  })

  it('adds the quiet zone and uses a whole number of pixels per module, at least two', () => {
    expect(qrUnits(Array.from({ length: 25 }, () => []))).toBe(33)
    expect(qrPixelSize(37)).toBe(148)
    expect(qrPixelSize(185)).toBe(370)
  })

  it('counts down without reading 0:00 while it still works, and never below zero', () => {
    expect(formatCountdown(102_000)).toBe('1:42')
    expect(formatCountdown(400)).toBe('0:01')
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})

describe('paired phones', () => {
  it('falls back to when a phone was paired if it was never seen', () => {
    const now = Date.UTC(2026, 9, 23, 12)
    expect(
      deviceActivity({ connected: false, lastSeenAt: null, createdAt: now - 10 * 60_000 }, now)
    ).toBe('10 min ago')
  })

  it('keeps the popover inside a narrow window', () => {
    expect(
      phonePopoverPosition({ left: 300, right: 329, top: 2, bottom: 31 }, 'beside', {
        width: 400,
        height: 30
      })
    ).toEqual({ left: 72, bottom: 8, maxHeight: 14 })
  })

  it('drops the prefix Electron adds to errors from the main process', () => {
    expect(
      companionErrorMessage(
        new Error("Error invoking remote method 'companion:setEnabled': Error: No Wi-Fi network")
      )
    ).toBe('No Wi-Fi network')
  })
})
