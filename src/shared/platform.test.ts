import { describe, expect, it } from 'vitest'
import { desktopPlatform } from './platform'

describe('desktopPlatform', () => {
  it('normalizes Node platform names for the renderer contract', () => {
    expect(desktopPlatform('darwin')).toBe('macos')
    expect(desktopPlatform('win32')).toBe('windows')
    expect(desktopPlatform('linux')).toBe('linux')
  })
})
