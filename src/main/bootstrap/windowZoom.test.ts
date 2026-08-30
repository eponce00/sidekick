import { describe, expect, it } from 'vitest'
import { applyWindowZoom, DEFAULT_ZOOM, installWindowZoom, zoomActionForInput } from './windowZoom'

const input = (key: string, code: string, extra: Partial<Parameters<typeof zoomActionForInput>[0]> = {}) => ({
  type: 'keyDown' as const,
  control: true,
  meta: false,
  alt: false,
  key,
  code,
  ...extra
})

describe('window zoom shortcuts', () => {
  it('supports conventional keyboard and numpad shortcuts', () => {
    expect(zoomActionForInput(input('+', 'Equal'))).toBe('in')
    expect(zoomActionForInput(input('-', 'Minus'))).toBe('out')
    expect(zoomActionForInput(input('0', 'Digit0'))).toBe('reset')
    expect(zoomActionForInput(input('Add', 'NumpadAdd'))).toBe('in')
  })

  it('starts fresh installs and reset at one step below 100%', () => {
    let zoom = 1
    const window = {
      webContents: {
        getZoomFactor: () => zoom,
        setZoomFactor: (value: number) => {
          zoom = value
        },
        on: () => undefined
      }
    }

    installWindowZoom(window as never)
    expect(zoom).toBe(DEFAULT_ZOOM)
    zoom = 1.2
    expect(applyWindowZoom(window as never, 'reset')).toBe(DEFAULT_ZOOM)
  })

  it('does not capture unmodified or Alt-modified keys', () => {
    expect(zoomActionForInput(input('+', 'Equal', { control: false }))).toBeNull()
    expect(zoomActionForInput(input('+', 'Equal', { alt: true }))).toBeNull()
  })
})
