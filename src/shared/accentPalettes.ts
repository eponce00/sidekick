// Accent palettes, shared so the main process can draw its own windows in the chosen colours.
interface AccentShades {
  accent: string
  accentStrong: string
  accentPressed: string
  accentSubtle: string
  accentMuted: string
  focusRing: string
}

export interface AccentPalette {
  id: string
  name: string
  swatch: string // preview dot color
  /** The robot's LEDs: the palette at full brightness, on its dark visor in both themes. */
  led: string
  dark: AccentShades
  light: AccentShades
}

/** The ink on a dark theme's accent fills, whichever palette is chosen. */
export const DARK_ON_ACCENT = '#111111'

/** The palette a new install starts with. */
export const DEFAULT_ACCENT_PALETTE = 'blue'

/**
 * Bumped when SideKick's look is redrawn as a whole. A choice made under an older look moves to
 * the new default once, so the redraw is seen; choosing again afterwards sticks.
 */
export const ACCENT_PALETTE_VERSION = 4

export function migrateAccentPalette<
  T extends { accentPalette?: string; accentPaletteVersion?: number }
>(settings: T): T {
  if (settings.accentPaletteVersion === ACCENT_PALETTE_VERSION) return settings
  return {
    ...settings,
    accentPalette: DEFAULT_ACCENT_PALETTE,
    accentPaletteVersion: ACCENT_PALETTE_VERSION
  }
}

function rgbOf(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')
}

/** Accents sit quietly on neutral greys: soft fills, a soft focus ring. */
function shades([accent, accentStrong, accentPressed]: string[], fill: number): AccentShades {
  const rgb = rgbOf(accent)
  return {
    accent,
    accentStrong,
    accentPressed,
    accentSubtle: `rgba(${rgb}, ${fill})`,
    accentMuted: `rgba(${rgb}, ${fill + 0.06})`,
    focusRing: `0 0 0 3px rgba(${rgb}, 0.26)`
  }
}

function palette(
  id: string,
  name: string,
  led: string,
  dark: [string, string, string],
  light: [string, string, string]
): AccentPalette {
  return { id, name, swatch: dark[0], led, dark: shades(dark, 0.08), light: shades(light, 0.07) }
}

/* Light accents must read at 4.5:1 as text on --surface-2 and carry white on a
 * fill; dark accents carry --on-accent. Palettes are applied inline at runtime,
 * so they override App.css and have to meet the same bar. */
export const ACCENT_PALETTES: AccentPalette[] = [
  palette(
    'blue',
    'Blue',
    '#60a5fa',
    ['#86aee8', '#a1c0ee', '#6c97d6'],
    ['#2850b8', '#1f419a', '#18347d']
  ),
  palette(
    'lime',
    'Lime',
    '#c8ff3d',
    ['#b4d36b', '#c3de86', '#9cbc52'],
    ['#4a6e14', '#3e5d10', '#334d0c']
  ),
  palette(
    'sage',
    'Sage',
    '#a6f5c0',
    ['#97c4a4', '#acd2b7', '#80ae8e'],
    ['#3b6a4a', '#30593e', '#264833']
  ),
  // White and grey only; colour is left to status and the robot.
  palette(
    'mono',
    'Mono',
    '#f0f0f0',
    ['#e4e4e4', '#f2f2f2', '#c8c8c8'],
    ['#1f1f1f', '#111111', '#000000']
  ),
  palette(
    'teal',
    'Teal',
    '#2dd4bf',
    ['#6cc9bb', '#8ad6ca', '#52b3a5'],
    ['#0f6b64', '#0b5a54', '#084843']
  ),
  palette(
    'violet',
    'Violet',
    '#a78bfa',
    ['#ab9be6', '#bfb2ee', '#9483d6'],
    ['#5b3fc0', '#4b33a0', '#3c2882']
  ),
  palette(
    'rose',
    'Rose',
    '#fb7185',
    ['#e98e9c', '#f0a8b3', '#d77585'],
    ['#b01e45', '#931838', '#77122d']
  ),
  palette(
    'amber',
    'Amber',
    '#fbbf24',
    ['#d9b26a', '#e3c387', '#c49b52'],
    ['#8f4c0a', '#773f08', '#5f3206']
  ),
  palette(
    'emerald',
    'Emerald',
    '#34d399',
    ['#6fc9a0', '#8fd7b6', '#56b388'],
    ['#036a4c', '#025a40', '#024a34']
  )
]

/** A palette by its id, or the default for an unknown or missing one. */
export function accentPalette(id: string | undefined): AccentPalette {
  return (
    ACCENT_PALETTES.find((palette) => palette.id === id) ??
    ACCENT_PALETTES.find((palette) => palette.id === DEFAULT_ACCENT_PALETTE)!
  )
}
