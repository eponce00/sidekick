import { describe, expect, it } from 'vitest'
import { getContrastRatio, parseCssColor } from './artifactContrast'

describe('artifact contrast guard', () => {
  it('detects unreadable dark-on-dark text and readable light-on-dark text', () => {
    const background = parseCssColor('#111827')!
    const darkText = parseCssColor('#1f2937')!
    const lightText = parseCssColor('#f9fafb')!

    expect(getContrastRatio(darkText, background)).toBeLessThan(2.25)
    expect(getContrastRatio(lightText, background)).toBeGreaterThan(10)
  })
})
