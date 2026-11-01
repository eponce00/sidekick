import { describe, expect, it } from 'vitest'
import { legacyTextScale, nearestTextScale, steppedTextScale, zoomForTextScale } from './textScale'

describe('text scale', () => {
  it('lands any stored size on a step', () => {
    expect(nearestTextScale(undefined)).toBe(100)
    expect(nearestTextScale('big')).toBe(100)
    expect(nearestTextScale(104)).toBe(100)
    expect(nearestTextScale(128)).toBe(135)
    expect(nearestTextScale(500)).toBe(150)
    expect(steppedTextScale(104, 'in')).toBe(110)
  })

  it('maps 100% to the zoom the interface is designed at', () => {
    expect(zoomForTextScale(100)).toBe(0.9)
    expect(zoomForTextScale(150)).toBe(1.35)
  })

  it('keeps what an earlier version showed', () => {
    expect(legacyTextScale(undefined, undefined)).toBe(100)
    expect(legacyTextScale(0.9, 13)).toBe(100)
    expect(legacyTextScale(1, 13)).toBe(110)
    expect(legacyTextScale(0.9, 16)).toBe(120)
    expect(legacyTextScale(1.2, 15)).toBe(150)
  })
})
