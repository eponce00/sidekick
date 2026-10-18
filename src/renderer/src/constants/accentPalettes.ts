import { ACCENT_PALETTES, DARK_ON_ACCENT } from '../../../shared/accentPalettes'

export function applyAccentPalette(paletteId: string, theme: 'dark' | 'light'): void {
  const palette = ACCENT_PALETTES.find((p) => p.id === paletteId)
  if (!palette) return
  const colors = theme === 'light' ? palette.light : palette.dark
  const el = document.body
  el.style.setProperty('--accent', colors.accent)
  // Keep legacy surfaces on the same runtime palette until the alias is fully retired.
  el.style.setProperty('--accent-color', colors.accent)
  el.style.setProperty('--accent-strong', colors.accentStrong)
  el.style.setProperty('--accent-pressed', colors.accentPressed)
  el.style.setProperty('--accent-subtle', colors.accentSubtle)
  el.style.setProperty('--accent-muted', colors.accentMuted)
  // Dark-mode accents are light; light-mode accents are dark.
  // Keep foreground contrast synchronized when the palette changes at runtime.
  el.style.setProperty('--on-accent', theme === 'light' ? '#ffffff' : DARK_ON_ACCENT)
  el.style.setProperty('--focus-ring', colors.focusRing)
  el.style.setProperty('--brand-led', palette.led)
}
