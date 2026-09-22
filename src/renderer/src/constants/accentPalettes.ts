// ---- Accent palette definitions ----
export interface AccentPalette {
  id: string
  name: string
  swatch: string // preview dot color
  dark: {
    accent: string
    accentStrong: string
    accentPressed: string
    accentSubtle: string
    accentMuted: string
    focusRing: string
  }
  light: {
    accent: string
    accentStrong: string
    accentPressed: string
    accentSubtle: string
    accentMuted: string
    focusRing: string
  }
}

/* Light accents must read at 4.5:1 as text on --surface-2 and carry white on a
 * fill; dark accents are bright and carry --on-accent. Palettes are applied
 * inline at runtime, so they override App.css and have to meet the same bar. */
export const ACCENT_PALETTES: AccentPalette[] = [
  {
    id: 'teal',
    name: 'Teal',
    swatch: '#2dd4bf',
    dark: {
      accent: '#3bd4bd',
      accentStrong: '#64e3d0',
      accentPressed: '#14b8a6',
      accentSubtle: 'rgba(45, 212, 191, 0.10)',
      accentMuted: 'rgba(45, 212, 191, 0.20)',
      focusRing: '0 0 0 3px rgba(59, 212, 189, 0.28)'
    },
    light: {
      accent: '#0f766e',
      accentStrong: '#115e59',
      accentPressed: '#0f4f4a',
      accentSubtle: 'rgba(15, 118, 110, 0.09)',
      accentMuted: 'rgba(15, 118, 110, 0.17)',
      focusRing: '0 0 0 3px rgba(15, 118, 110, 0.32)'
    }
  },
  {
    id: 'blue',
    name: 'Blue',
    swatch: '#60a5fa',
    dark: {
      accent: '#60a5fa',
      accentStrong: '#93c5fd',
      accentPressed: '#3b82f6',
      accentSubtle: 'rgba(96, 165, 250, 0.10)',
      accentMuted: 'rgba(96, 165, 250, 0.20)',
      focusRing: '0 0 0 2px rgba(96, 165, 250, 0.25)'
    },
    light: {
      accent: '#1d4ed8',
      accentStrong: '#1e40af',
      accentPressed: '#1e3a8a',
      accentSubtle: 'rgba(29, 78, 216, 0.09)',
      accentMuted: 'rgba(29, 78, 216, 0.17)',
      focusRing: '0 0 0 3px rgba(29, 78, 216, 0.32)'
    }
  },
  {
    id: 'violet',
    name: 'Violet',
    swatch: '#a78bfa',
    dark: {
      accent: '#a78bfa',
      accentStrong: '#c4b5fd',
      accentPressed: '#8b5cf6',
      accentSubtle: 'rgba(167, 139, 250, 0.10)',
      accentMuted: 'rgba(167, 139, 250, 0.20)',
      focusRing: '0 0 0 2px rgba(167, 139, 250, 0.25)'
    },
    light: {
      accent: '#6d28d9',
      accentStrong: '#5b21b6',
      accentPressed: '#4c1d95',
      accentSubtle: 'rgba(109, 40, 217, 0.09)',
      accentMuted: 'rgba(109, 40, 217, 0.17)',
      focusRing: '0 0 0 3px rgba(109, 40, 217, 0.32)'
    }
  },
  {
    id: 'rose',
    name: 'Rose',
    swatch: '#fb7185',
    dark: {
      accent: '#fb7185',
      accentStrong: '#fda4af',
      accentPressed: '#f43f5e',
      accentSubtle: 'rgba(251, 113, 133, 0.10)',
      accentMuted: 'rgba(251, 113, 133, 0.20)',
      focusRing: '0 0 0 2px rgba(251, 113, 133, 0.25)'
    },
    light: {
      accent: '#be123c',
      accentStrong: '#9f1239',
      accentPressed: '#881337',
      accentSubtle: 'rgba(190, 18, 60, 0.09)',
      accentMuted: 'rgba(190, 18, 60, 0.17)',
      focusRing: '0 0 0 3px rgba(190, 18, 60, 0.32)'
    }
  },
  {
    id: 'amber',
    name: 'Amber',
    swatch: '#fbbf24',
    dark: {
      accent: '#fbbf24',
      accentStrong: '#fcd34d',
      accentPressed: '#f59e0b',
      accentSubtle: 'rgba(251, 191, 36, 0.10)',
      accentMuted: 'rgba(251, 191, 36, 0.20)',
      focusRing: '0 0 0 2px rgba(251, 191, 36, 0.25)'
    },
    light: {
      accent: '#a35208',
      accentStrong: '#8a4507',
      accentPressed: '#713a05',
      accentSubtle: 'rgba(163, 82, 8, 0.09)',
      accentMuted: 'rgba(163, 82, 8, 0.17)',
      focusRing: '0 0 0 3px rgba(163, 82, 8, 0.32)'
    }
  },
  {
    id: 'emerald',
    name: 'Emerald',
    swatch: '#34d399',
    dark: {
      accent: '#34d399',
      accentStrong: '#6ee7b7',
      accentPressed: '#10b981',
      accentSubtle: 'rgba(52, 211, 153, 0.10)',
      accentMuted: 'rgba(52, 211, 153, 0.20)',
      focusRing: '0 0 0 2px rgba(52, 211, 153, 0.25)'
    },
    light: {
      accent: '#047857',
      accentStrong: '#065f46',
      accentPressed: '#064e3b',
      accentSubtle: 'rgba(4, 120, 87, 0.09)',
      accentMuted: 'rgba(4, 120, 87, 0.17)',
      focusRing: '0 0 0 3px rgba(4, 120, 87, 0.32)'
    }
  }
]

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
  // Dark-mode accents are deliberately bright; light-mode accents are dark.
  // Keep foreground contrast synchronized when the palette changes at runtime.
  el.style.setProperty('--on-accent', theme === 'light' ? '#ffffff' : '#06201b')
  el.style.setProperty('--focus-ring', colors.focusRing)
}
