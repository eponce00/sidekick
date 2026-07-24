import { describe, expect, it } from 'vitest'
import { parseStoredWindowState, visibleWindowBounds } from './windowState'

describe('window state', () => {
  it('rejects malformed and unusably small stored state', () => {
    expect(parseStoredWindowState(null)).toBeNull()
    expect(parseStoredWindowState({ x: 0, y: 0, width: 400, height: 300 })).toBeNull()
    expect(parseStoredWindowState({ x: '0', y: 0, width: 900, height: 700 })).toBeNull()
  })

  it('keeps visible state and clamps it to the matching work area', () => {
    const state = parseStoredWindowState({
      x: 1600,
      y: -40,
      width: 1000,
      height: 900,
      maximized: true
    })
    expect(visibleWindowBounds(state, [{ x: 1440, y: 0, width: 900, height: 700 }])).toEqual({
      x: 1440,
      y: 0,
      width: 900,
      height: 700
    })
  })

  it('ignores a state stranded on a disconnected display', () => {
    const state = parseStoredWindowState({
      x: 2400,
      y: 100,
      width: 900,
      height: 700,
      maximized: false
    })
    expect(visibleWindowBounds(state, [{ x: 0, y: 0, width: 1440, height: 900 }])).toBeNull()
  })
})
