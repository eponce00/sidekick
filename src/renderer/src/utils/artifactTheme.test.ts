import { describe, expect, it } from 'vitest'
import {
  createArtifactThemeStyle,
  getArtifactThemeCssVariables,
  type ArtifactTheme
} from './artifactTheme'

const theme: ArtifactTheme = {
  themeMode: 'dark',
  background: '#101214',
  panelBg: '#15181c',
  surface: '#20242a',
  surface0: '#101214',
  surface1: '#15181c',
  surface2: '#20242a',
  surface3: '#2a3038',
  surface4: '#343c46',
  surfaceHover: '#2a3038',
  inputBg: '#20242a',
  border: '#38404a',
  borderSubtle: '#2b3139',
  borderStrong: '#4b5663',
  textPrimary: '#f4f6f8',
  textSecondary: '#b2bac4',
  textMuted: '#798492',
  accent: '#3bd4bd',
  accentStrong: '#64e3d0',
  accentPressed: '#14b8a6',
  accentSubtle: 'rgba(45, 212, 191, 0.1)',
  accentMuted: 'rgba(45, 212, 191, 0.2)',
  onAccent: '#06201b',
  success: '#4a9',
  error: '#c55',
  warning: '#d9a43e'
}

describe('artifact theme contract', () => {
  it('exposes complete Sidekick and semantic aliases to generated code', () => {
    const variables = getArtifactThemeCssVariables(theme)

    expect(variables['--surface-3']).toBe(theme.surface3)
    expect(variables['--border']).toBe(theme.border)
    expect(variables['--primary']).toBe(theme.accent)
    expect(variables['--primary-foreground']).toBe(theme.onAccent)
    expect(variables['--foreground']).toBe(theme.textPrimary)
    expect(variables['--textPrimary']).toBe(theme.textPrimary)
  })

  it('serializes the mode and variables for HTML artifact bootstrapping', () => {
    const css = createArtifactThemeStyle(theme)

    expect(css).toContain('--app-bg:#101214')
    expect(css).toContain('--on-accent:#06201b')
    expect(css).toContain('color-scheme:dark')
  })
})
