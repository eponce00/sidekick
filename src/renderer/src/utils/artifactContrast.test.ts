import { describe, expect, it } from 'vitest'
import { getContrastRatio, parseCssColor } from './artifactContrast'

describe('artifact contrast guard', () => {
  it('parses common generated CSS color formats', () => {
    expect(parseCssColor('#fff')).toEqual({ red: 255, green: 255, blue: 255, alpha: 1 })
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({
      red: 10,
      green: 20,
      blue: 30,
      alpha: 0.5
    })
  })

  it('detects unreadable dark-on-dark text and readable light-on-dark text', () => {
    const background = parseCssColor('#111827')!
    const darkText = parseCssColor('#1f2937')!
    const lightText = parseCssColor('#f9fafb')!

    expect(getContrastRatio(darkText, background)).toBeLessThan(2.25)
    expect(getContrastRatio(lightText, background)).toBeGreaterThan(10)
  })
})
