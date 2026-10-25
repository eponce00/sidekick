// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  applyArtifactTheme,
  createArtifactThemeStyle,
  getArtifactFallbackTheme,
  getArtifactTheme
} from './artifactTheme'

describe('artifact theme in the renderer', () => {
  it('serializes the mode and variables for a document that needs them before its scripts', () => {
    const css = createArtifactThemeStyle({
      ...getArtifactFallbackTheme('dark'),
      background: '#101214',
      onAccent: '#06201b'
    })

    expect(css).toContain('--app-bg:#101214')
    expect(css).toContain('--on-accent:#06201b')
    expect(css).toContain('color-scheme:dark')
  })

  it('reads the mode and type tokens from the app', () => {
    document.body.dataset.theme = 'light'
    document.body.style.setProperty('--font-sans', "'Inter', sans-serif")
    const theme = getArtifactTheme()

    expect(theme.themeMode).toBe('light')
    expect(theme.fontSans).toBe("'Inter', sans-serif")
    expect(theme.radiusLg).toBe(getArtifactFallbackTheme('light').radiusLg)
  })

  it('leaves the frame page transparent so the chat shows through', () => {
    const frame = document.implementation.createHTMLDocument('artifact')
    applyArtifactTheme(frame, getArtifactFallbackTheme('light'))

    expect(frame.documentElement.dataset.theme).toBe('light')
    expect(frame.documentElement.style.colorScheme).toBe('light')
    expect(frame.body.style.backgroundColor).toBe('')
  })
})
