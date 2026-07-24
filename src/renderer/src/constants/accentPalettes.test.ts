// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { applyAccentPalette } from './accentPalettes'

describe('applyAccentPalette', () => {
  beforeEach(() => document.body.removeAttribute('style'))

  it('updates both the canonical accent and legacy panel alias', () => {
    applyAccentPalette('blue', 'dark')

    expect(document.body.style.getPropertyValue('--accent')).toBe('#60a5fa')
    expect(document.body.style.getPropertyValue('--accent-color')).toBe('#60a5fa')
  })
})
