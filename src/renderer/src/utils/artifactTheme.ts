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
}

const DARK_FALLBACK: ArtifactTheme = {
  themeMode: 'dark',
  background: '#0b0d10',
  panelBg: '#12161b',
  surface: '#191e25',
  surface0: '#0e1115',
  surface1: '#12161b',
  surface2: '#191e25',
  surface3: '#232a34',
  surface4: '#2d3642',
  surfaceHover: '#232a34',
  inputBg: '#191e25',
  border: 'rgba(255, 255, 255, 0.075)',
  borderSubtle: 'rgba(255, 255, 255, 0.055)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',
  textPrimary: '#f0f3f7',
  textSecondary: '#a6afbd',
  textMuted: '#697585',
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

const LIGHT_FALLBACK: ArtifactTheme = {
  ...DARK_FALLBACK,
  themeMode: 'light',
  background: '#f6f7f8',
  panelBg: '#ffffff',
  surface: '#f0f2f4',
  surface0: '#fafbfc',
  surface1: '#ffffff',
  surface2: '#f0f2f4',
  surface3: '#e5e8eb',
  surface4: '#d9dde2',
  surfaceHover: '#e5e8eb',
  inputBg: '#ffffff',
  border: 'rgba(19, 30, 43, 0.09)',
  borderSubtle: 'rgba(19, 30, 43, 0.065)',
  borderStrong: 'rgba(19, 30, 43, 0.18)',
  textPrimary: '#17202b',
  textSecondary: '#536070',
  textMuted: '#7b8796',
  accent: '#0d9488',
  accentStrong: '#0f766e',
  accentPressed: '#115e59',
  accentSubtle: 'rgba(13, 148, 136, 0.08)',
  accentMuted: 'rgba(13, 148, 136, 0.15)',
  onAccent: '#ffffff',
  success: '#2d8a5e',
  error: '#c44',
  warning: '#b8862d'
}

type ArtifactThemeColorKey = Exclude<keyof ArtifactTheme, 'themeMode'>

const THEME_CSS_TOKENS: Array<[ArtifactThemeColorKey, string]> = [
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
  ['warning', '--color-warning']
]

function resolveCssVariable(
  resolver: HTMLDivElement,
  variableName: string,
  cssProperty: 'color' | 'backgroundColor' | 'borderTopColor',
  fallback: string
): string {
  resolver.style.color = ''
  resolver.style.backgroundColor = ''
  resolver.style.borderTopColor = ''
  resolver.style[cssProperty] = `var(${variableName})`
  return (
    resolver.ownerDocument.defaultView?.getComputedStyle(resolver)[cssProperty]?.trim() || fallback
  )
}

export function getArtifactTheme(doc: Document = document): ArtifactTheme {
  const resolver = doc.createElement('div')
  Object.assign(resolver.style, {
    position: 'absolute',
    pointerEvents: 'none',
    opacity: '0',
    width: '0',
    height: '0'
  })
  doc.body.appendChild(resolver)

  const mode: ArtifactThemeMode = doc.body.dataset.theme === 'light' ? 'light' : 'dark'
  const fallback = getArtifactFallbackTheme(mode)

  const theme = { ...fallback }
  for (const [key, variableName] of THEME_CSS_TOKENS) {
    const property = key.startsWith('border')
      ? 'borderTopColor'
      : key.includes('Bg') || key.startsWith('surface') || key === 'background'
        ? 'backgroundColor'
        : 'color'
    theme[key] = resolveCssVariable(resolver, variableName, property, fallback[key])
  }

  resolver.remove()
  return theme
}

export function getArtifactFallbackTheme(mode: ArtifactThemeMode): ArtifactTheme {
  return { ...(mode === 'light' ? LIGHT_FALLBACK : DARK_FALLBACK) }
}

export function getArtifactThemeCssVariables(theme: ArtifactTheme): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [key, variableName] of THEME_CSS_TOKENS) {
    variables[variableName] = theme[key]
  }

  return {
    ...variables,
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
    '--border': theme.border,
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

export function applyArtifactTheme(doc: Document, theme: ArtifactTheme): void {
  const root = doc.documentElement
  for (const [name, value] of Object.entries(getArtifactThemeCssVariables(theme))) {
    root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme.themeMode
  root.dataset.theme = theme.themeMode
  if (doc.body) {
    doc.body.dataset.theme = theme.themeMode
    doc.body.style.backgroundColor = theme.panelBg
    doc.body.style.color = theme.textPrimary
  }
}

export function createArtifactThemeStyle(theme: ArtifactTheme): string {
  const declarations = Object.entries(getArtifactThemeCssVariables(theme))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{${declarations};color-scheme:${theme.themeMode}}`
}

export function observeArtifactTheme(
  onChange: (theme: ArtifactTheme) => void,
  doc: Document = document
): () => void {
  const notify = (): void => onChange(getArtifactTheme(doc))
  const observer = new MutationObserver(notify)
  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  }
  observer.observe(doc.body, options)
  observer.observe(doc.documentElement, options)
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaQuery.addEventListener('change', notify)

  return () => {
    observer.disconnect()
    mediaQuery.removeEventListener('change', notify)
  }
}
