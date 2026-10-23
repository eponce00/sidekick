import { describe, expect, it } from 'vitest'
import {
  companionErrorMessage,
  deviceActivity,
  formatCountdown,
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
    expect(qrPixelSize(33)).toBe(198)
    expect(qrPixelSize(49)).toBe(196)
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
    ).toBe('Connected now')
  })

  it('says when a phone was last used', () => {
    expect(deviceActivity({ connected: false, lastSeenAt: now - 20_000, createdAt: 0 }, now)).toBe(
      'Last used just now'
    )
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 5 * 60_000, createdAt: 0 }, now)
    ).toBe('Last used 5 min ago')
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 3 * 3_600_000, createdAt: 0 }, now)
    ).toBe('Last used 3 h ago')
    expect(
      deviceActivity({ connected: false, lastSeenAt: now - 2 * 86_400_000, createdAt: 0 }, now)
    ).toBe('Last used 2 d ago')
  })

  it('falls back to when it was paired', () => {
    expect(
      deviceActivity({ connected: false, lastSeenAt: null, createdAt: now - 10 * 60_000 }, now)
    ).toBe('Last used 10 min ago')
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
