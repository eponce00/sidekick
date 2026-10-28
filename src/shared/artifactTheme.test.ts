import { describe, expect, it } from 'vitest'
import {
  getArtifactFallbackTheme,
  getArtifactThemeCssVariables,
  isSafeArtifactThemeValue,
  readArtifactTheme
} from './artifactTheme'

describe('the theme an artifact frame receives', () => {
  it('keeps the values a theme is made of: colors, font stacks, sizes', () => {
    for (const value of [
      '#3bd4bd',
      'rgba(45, 212, 191, 0.1)',
      'color-mix(in srgb, #fff 10%, transparent)',
      "'Inter', -apple-system, 'Segoe UI', sans-serif",
      '13px',
      '1.55'
    ]) {
      expect(isSafeArtifactThemeValue(value)).toBe(true)
    }
  })

  it('refuses a value that could end the declaration, rule or element, or fetch something', () => {
    for (const value of [
      'red; background: url(https://example.com/x)',
      'red}body{display:none',
      '#fff</style><script>alert(1)</script>',
      'url(https://example.com/track.png)',
      'image(https://example.com/x)',
      '\\72 ed',
      '@import "x"',
      'red /* note */',
      'x'.repeat(241),
      '',
      42
    ]) {
      expect(isSafeArtifactThemeValue(value)).toBe(false)
    }
  })

  it('puts the fallback for its mode in place of anything missing or unsafe', () => {
    const theme = readArtifactTheme({
      themeMode: 'light',
      accent: '#123456',
      textPrimary: 'red;}',
      fontSans: "'Inter', sans-serif",
      injected: 'ignored'
    })
    const light = getArtifactFallbackTheme('light')
    expect(theme?.accent).toBe('#123456')
    expect(theme?.fontSans).toBe("'Inter', sans-serif")
    expect(theme?.textPrimary).toBe(light.textPrimary)
    expect(theme?.surface2).toBe(light.surface2)
    expect(theme).not.toHaveProperty('injected')
  })

  it('is not a theme without a known mode', () => {
    expect(readArtifactTheme({ accent: '#fff' })).toBeNull()
    expect(readArtifactTheme({ themeMode: 'sepia' })).toBeNull()
    expect(readArtifactTheme(null)).toBeNull()
  })

  it('exposes the app tokens, chart colors led by the accent, and common aliases', () => {
    const theme = { ...getArtifactFallbackTheme('dark'), accent: '#3bd4bd' }
    const variables = getArtifactThemeCssVariables(theme)

    expect(variables['--surface-3']).toBe(theme.surface3)
    expect(variables['--chart-1']).toBe('#3bd4bd')
    expect(variables['--primary']).toBe(theme.accent)
  })
})
