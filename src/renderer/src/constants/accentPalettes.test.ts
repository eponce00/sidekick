// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { ACCENT_PALETTES, applyAccentPalette } from './accentPalettes'

describe('applyAccentPalette', () => {
  beforeEach(() => document.body.removeAttribute('style'))

  it('updates both the canonical accent and legacy panel alias', () => {
    applyAccentPalette('blue', 'dark')

    expect(document.body.style.getPropertyValue('--accent')).toBe('#60a5fa')
    expect(document.body.style.getPropertyValue('--accent-color')).toBe('#60a5fa')
  })
})

// Palettes are written inline at runtime, so they bypass App.css and must
// meet the same contrast bar on their own.
function contrast(a: string, b: string): number {
  const rgb = (hex: string): number[] => {
    const h = hex.replace('#', '')
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  }
  const lum = ([r, g, b2]: number[]): number => {
    const f = (v: number): number => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2)
  }
  const [l1, l2] = [lum(rgb(a)), lum(rgb(b))]
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('accent palette contrast', () => {
  const LIGHT_SURFACE = '#f0f2f4'
  const DARK_SURFACE = '#191e25'
  const DARK_ON_ACCENT = '#06201b'

  it.each(ACCENT_PALETTES.map((p) => [p.id, p] as const))(
    '%s light accent reads as text and carries white on a fill',
    (_id, palette) => {
      expect(contrast(palette.light.accent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5)
      expect(contrast('#ffffff', palette.light.accent)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it.each(ACCENT_PALETTES.map((p) => [p.id, p] as const))(
    '%s dark accent reads as text and carries the dark on-accent ink',
    (_id, palette) => {
      expect(contrast(palette.dark.accent, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(DARK_ON_ACCENT, palette.dark.accent)).toBeGreaterThanOrEqual(4.5)
    }
  )
})
