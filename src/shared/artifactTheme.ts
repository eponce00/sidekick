/**
 * The look an artifact inherits from SideKick: its colors, fonts and corner radii, in the user's
 * theme and accent palette. The chat sends it to the artifact's frame, which is less trusted than
 * the chat, so every value is checked before it becomes CSS (`readArtifactTheme`).
 */

export type ArtifactThemeMode = 'dark' | 'light'

export interface ArtifactTheme {
  themeMode: ArtifactThemeMode
  background: string
  panelBg: string
  surface: string
  surface0: string
  surface1: string
  surface2: string
  surface3: string
  surface4: string
  surfaceHover: string
  inputBg: string
  border: string
  borderSubtle: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  accent: string
  accentStrong: string
  accentPressed: string
  accentSubtle: string
  accentMuted: string
  onAccent: string
  success: string
  error: string
  warning: string
  fontSans: string
  fontMono: string
  /** The chat's body text size, which an artifact's text matches. */
  textSize: string
  leading: string
  radiusSm: string
  radiusMd: string
  radiusLg: string
}

const TYPE_AND_SHAPE = {
  fontSans:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
  fontMono: "'SF Mono', 'Consolas', 'Monaco', 'Fira Code', monospace",
  textSize: '13px',
  leading: '1.55',
  radiusSm: '6px',
  radiusMd: '10px',
  radiusLg: '14px'
}

const DARK_FALLBACK: ArtifactTheme = {
  themeMode: 'dark',
  background: '#0f0f0f',
  panelBg: '#171717',
  surface: '#1d1d1d',
  surface0: '#131313',
  surface1: '#171717',
  surface2: '#1d1d1d',
  surface3: '#252525',
  surface4: '#2f2f2f',
  surfaceHover: '#252525',
  inputBg: '#1d1d1d',
  border: 'rgba(255, 255, 255, 0.075)',
  borderSubtle: 'rgba(255, 255, 255, 0.055)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',
  textPrimary: '#ececec',
  textSecondary: '#a9a9a9',
  textMuted: '#8d8d8d',
  accent: '#86aee8',
  accentStrong: '#a1c0ee',
  accentPressed: '#6c97d6',
  accentSubtle: 'rgba(134, 174, 232, 0.1)',
  accentMuted: 'rgba(134, 174, 232, 0.18)',
  onAccent: '#111111',
  success: '#5fcf9f',
  error: '#f0717f',
  warning: '#e9a05f',
  ...TYPE_AND_SHAPE
}

const LIGHT_FALLBACK: ArtifactTheme = {
  ...DARK_FALLBACK,
  themeMode: 'light',
  background: '#efefef',
  panelBg: '#ffffff',
  surface: '#eeeeee',
  surface0: '#f6f6f6',
  surface1: '#ffffff',
  surface2: '#eeeeee',
  surface3: '#e3e3e3',
  surface4: '#d6d6d6',
  surfaceHover: '#e3e3e3',
  inputBg: '#ffffff',
  border: 'rgba(0, 0, 0, 0.09)',
  borderSubtle: 'rgba(0, 0, 0, 0.065)',
  borderStrong: 'rgba(0, 0, 0, 0.18)',
  textPrimary: '#161616',
  textSecondary: '#4c4c4c',
  textMuted: '#5c5c5c',
  accent: '#2850b8',
  accentStrong: '#1f419a',
  accentPressed: '#18347d',
  accentSubtle: 'rgba(40, 80, 184, 0.09)',
  accentMuted: 'rgba(40, 80, 184, 0.17)',
  onAccent: '#ffffff',
  success: '#036a4c',
  error: '#b4233f',
  warning: '#a23d0e'
}

/**
 * Categorical series colors after the accent, quiet enough to sit beside the app's own. Their
 * hues stay clear of the semantic success, warning and error colors' meanings by convention only:
 * a chart may still color a bad value red.
 */
const CHART_SERIES: Record<ArtifactThemeMode, string[]> = {
  dark: ['#5fc7b8', '#e3b16a', '#b19be9', '#ea8ca6'],
  light: ['#0f7d6d', '#a3600b', '#6a4bc7', '#b23b63']
}

export type ArtifactThemeValueKey = Exclude<keyof ArtifactTheme, 'themeMode'>

/** Theme values and the app's CSS variables they come from, which artifacts also see. */
export const ARTIFACT_THEME_TOKENS: ReadonlyArray<readonly [ArtifactThemeValueKey, string]> = [
  ['background', '--app-bg'],
  ['panelBg', '--panel-bg'],
  ['surface', '--surface'],
  ['surface0', '--surface-0'],
  ['surface1', '--surface-1'],
  ['surface2', '--surface-2'],
  ['surface3', '--surface-3'],
  ['surface4', '--surface-4'],
  ['surfaceHover', '--surface-hover'],
  ['inputBg', '--input-bg'],
  ['border', '--panel-border'],
  ['borderSubtle', '--border-subtle'],
  ['borderStrong', '--border-strong'],
  ['textPrimary', '--text-primary'],
  ['textSecondary', '--text-secondary'],
  ['textMuted', '--text-muted'],
  ['accent', '--accent'],
  ['accentStrong', '--accent-strong'],
  ['accentPressed', '--accent-pressed'],
  ['accentSubtle', '--accent-subtle'],
  ['accentMuted', '--accent-muted'],
  ['onAccent', '--on-accent'],
  ['success', '--color-success'],
  ['error', '--color-error'],
  ['warning', '--color-warning'],
  ['fontSans', '--font-sans'],
  ['fontMono', '--font-mono'],
  ['textSize', '--content-text'],
  ['leading', '--content-leading'],
  ['radiusSm', '--radius-sm'],
  ['radiusMd', '--radius-md'],
  ['radiusLg', '--radius-lg']
]

/** Values that are colors, which the app resolves to computed colors before sending. */
export const ARTIFACT_THEME_COLOR_KEYS: ReadonlySet<ArtifactThemeValueKey> = new Set(
  ARTIFACT_THEME_TOKENS.map(([key]) => key).filter((key) => !(key in TYPE_AND_SHAPE))
)

export function getArtifactFallbackTheme(mode: ArtifactThemeMode): ArtifactTheme {
  return { ...(mode === 'light' ? LIGHT_FALLBACK : DARK_FALLBACK) }
}

/**
 * A theme value that can only ever be one CSS value: no declaration or rule boundary, no markup,
 * no escapes and no resource to fetch. Fonts need quotes and commas; colors need parentheses.
 */
export function isSafeArtifactThemeValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[;{}<>\\@]|\/\*|url\s*\(|image\s*\(|expression\s*\(/i.test(value)
  )
}

/**
 * The theme as a frame receives it: known values only, each one checked, with the fallback for
 * its mode in place of anything missing or unsafe. Null when it is not a theme at all.
 */
export function readArtifactTheme(value: unknown): ArtifactTheme | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.themeMode !== 'dark' && record.themeMode !== 'light') return null
  const theme = getArtifactFallbackTheme(record.themeMode)
  for (const [key] of ARTIFACT_THEME_TOKENS) {
    const candidate = record[key]
    if (isSafeArtifactThemeValue(candidate)) theme[key] = candidate
  }
  return theme
}

export function getArtifactThemeCssVariables(theme: ArtifactTheme): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [key, variableName] of ARTIFACT_THEME_TOKENS) {
    variables[variableName] = theme[key]
  }
  const series = CHART_SERIES[theme.themeMode]

  return {
    ...variables,
    '--border': theme.border,
    '--border-color': theme.border,
    '--chart-1': theme.accent,
    '--chart-2': series[0],
    '--chart-3': series[1],
    '--chart-4': series[2],
    '--chart-5': series[3],
    '--background': theme.background,
    '--foreground': theme.textPrimary,
    '--card': theme.panelBg,
    '--card-foreground': theme.textPrimary,
    '--popover': theme.panelBg,
    '--popover-foreground': theme.textPrimary,
    '--primary': theme.accent,
    '--primary-foreground': theme.onAccent,
    '--secondary': theme.surface2,
    '--secondary-foreground': theme.textPrimary,
    '--muted': theme.surface2,
    '--muted-foreground': theme.textMuted,
    '--input': theme.inputBg,
    '--ring': theme.accent,
    '--success': theme.success,
    '--error': theme.error,
    '--warning': theme.warning,
    '--textPrimary': theme.textPrimary,
    '--textSecondary': theme.textSecondary,
    '--textMuted': theme.textMuted,
    '--panelBg': theme.panelBg,
    '--panelBorder': theme.border,
    '--appBg': theme.background,
    '--onAccent': theme.onAccent
  }
}
