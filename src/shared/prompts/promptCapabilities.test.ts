import { describe, expect, it } from 'vitest'
import { detectHostPlatform } from './promptCapabilities'

describe('prompt host platform', () => {
  it('normalizes Node and browser platform identities', () => {
    expect(detectHostPlatform('win32')).toBe('windows')
    expect(detectHostPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('macos')
    expect(detectHostPlatform('X11; Linux x86_64')).toBe('linux')
  })
})
