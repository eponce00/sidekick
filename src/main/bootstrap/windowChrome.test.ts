import { describe, expect, it } from 'vitest'
import { mainWindowChrome } from './windowChrome'

describe('mainWindowChrome', () => {
  it('uses native hidden-inset macOS chrome and native full screen', () => {
    expect(mainWindowChrome('macos')).toEqual({
      frame: true,
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      fullscreenable: true,
      simpleFullscreen: false
    })
  })

  it('preserves SideKick custom chrome on Windows and Linux', () => {
    expect(mainWindowChrome('windows')).toEqual({ frame: false, fullscreenable: true })
    expect(mainWindowChrome('linux')).toEqual({ frame: false, fullscreenable: true })
  })
})
