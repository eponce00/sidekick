import { describe, expect, it } from 'vitest'
import { isBrowserZoomStep, steppedBrowserZoom } from './browserZoom'

describe('browser page zoom', () => {
  it('steps through a browser’s levels, from 100% by default', () => {
    expect(steppedBrowserZoom(100, 'in')).toBe(110)
    expect(steppedBrowserZoom(100, 'out')).toBe(90)
    expect(steppedBrowserZoom(67, 'out')).toBe(50)
    expect(steppedBrowserZoom(250, 'reset')).toBe(100)
  })

  it('stays within the levels, and lands an odd value on the nearest', () => {
    expect(steppedBrowserZoom(300, 'in')).toBe(300)
    expect(steppedBrowserZoom(50, 'out')).toBe(50)
    expect(steppedBrowserZoom(104, 'in')).toBe(110)
  })

  it('accepts only the three steps from the panel', () => {
    expect(isBrowserZoomStep('in')).toBe(true)
    expect(isBrowserZoomStep('reset')).toBe(true)
    expect(isBrowserZoomStep('200')).toBe(false)
  })
})
