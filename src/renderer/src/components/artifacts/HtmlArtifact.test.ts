import { describe, expect, it } from 'vitest'
import type { ArtifactTheme } from '../../utils/artifactTheme'
import { buildArtifactSrcDoc } from '../../utils/htmlArtifactDocument'

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

describe('HTML artifact document', () => {
  it('injects the shared theme before generated styles and bridges runtime updates', () => {
    const html = buildArtifactSrcDoc(
      '<!doctype html><html><head><style id="generated">button{color:red}</style></head><body><button>Go</button></body></html>',
      theme
    )

    expect(html).toContain('id="sidekick-artifact-theme"')
    expect(html).toContain('--border:#38404a')
    expect(html).toContain('--on-accent:#06201b')
    expect(html.indexOf('sidekick-artifact-theme')).toBeLessThan(html.indexOf('id="generated"'))
    expect(html).toContain('event.source !== parent')
    expect(html).toContain("type: 'html-artifact-error'")
    expect(html).toContain('</script>')
    expect(html).not.toContain('<\\/script>')
  })

  it('creates a themed head when generated markup omits one', () => {
    const html = buildArtifactSrcDoc('<html><body><p>Hello</p></body></html>', theme)

    expect(html).toMatch(/<html>\s*<head><style id="sidekick-artifact-theme">/)
    expect(html).toContain('<p>Hello</p>')
  })
})
