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

export const ACCENT_PALETTES: AccentPalette[] = [
  {
    id: 'teal',
    name: 'Teal',
    swatch: '#2dd4bf',
    dark: {
      accent: '#2dd4bf',
      accentStrong: '#5eead4',
      accentPressed: '#14b8a6',
      accentSubtle: 'rgba(45, 212, 191, 0.10)',
      accentMuted: 'rgba(45, 212, 191, 0.20)',
      focusRing: '0 0 0 2px rgba(45, 212, 191, 0.25)'
    },
    light: {
      accent: '#0d9488',
      accentStrong: '#0f766e',
      accentPressed: '#115e59',
      accentSubtle: 'rgba(13, 148, 136, 0.08)',
      accentMuted: 'rgba(13, 148, 136, 0.15)',
      focusRing: '0 0 0 2px rgba(13, 148, 136, 0.25)'
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
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      accentPressed: '#1e40af',
      accentSubtle: 'rgba(37, 99, 235, 0.08)',
      accentMuted: 'rgba(37, 99, 235, 0.15)',
      focusRing: '0 0 0 2px rgba(37, 99, 235, 0.25)'
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
      accent: '#7c3aed',
      accentStrong: '#6d28d9',
      accentPressed: '#5b21b6',
      accentSubtle: 'rgba(124, 58, 237, 0.08)',
      accentMuted: 'rgba(124, 58, 237, 0.15)',
      focusRing: '0 0 0 2px rgba(124, 58, 237, 0.25)'
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
      accent: '#e11d48',
      accentStrong: '#be123c',
      accentPressed: '#9f1239',
      accentSubtle: 'rgba(225, 29, 72, 0.08)',
      accentMuted: 'rgba(225, 29, 72, 0.15)',
      focusRing: '0 0 0 2px rgba(225, 29, 72, 0.25)'
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
      accent: '#d97706',
      accentStrong: '#b45309',
      accentPressed: '#92400e',
      accentSubtle: 'rgba(217, 119, 6, 0.08)',
      accentMuted: 'rgba(217, 119, 6, 0.15)',
      focusRing: '0 0 0 2px rgba(217, 119, 6, 0.25)'
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
      accent: '#059669',
      accentStrong: '#047857',
      accentPressed: '#065f46',
      accentSubtle: 'rgba(5, 150, 105, 0.08)',
      accentMuted: 'rgba(5, 150, 105, 0.15)',
      focusRing: '0 0 0 2px rgba(5, 150, 105, 0.25)'
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
