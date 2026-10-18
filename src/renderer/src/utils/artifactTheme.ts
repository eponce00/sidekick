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
  background: '#0a0b0e',
  panelBg: '#111318',
  surface: '#171920',
  surface0: '#0d0e12',
  surface1: '#111318',
  surface2: '#171920',
  surface3: '#1f222b',
  surface4: '#282c37',
  surfaceHover: '#1f222b',
  inputBg: '#171920',
  border: 'rgba(255, 255, 255, 0.075)',
  borderSubtle: 'rgba(255, 255, 255, 0.055)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',
  textPrimary: '#eef0f4',
  textSecondary: '#a3a8b5',
  textMuted: '#858b99',
  accent: '#c8ff3d',
  accentStrong: '#d6ff6e',
  accentPressed: '#a8e01f',
  accentSubtle: 'rgba(200, 255, 61, 0.1)',
  accentMuted: 'rgba(200, 255, 61, 0.18)',
  onAccent: '#0b0c10',
  success: '#34d399',
  error: '#ff5470',
  warning: '#ff9f43'
}

const LIGHT_FALLBACK: ArtifactTheme = {
  ...DARK_FALLBACK,
  themeMode: 'light',
  background: '#f1f2f4',
  panelBg: '#ffffff',
  surface: '#eff1f4',
  surface0: '#f7f8fa',
  surface1: '#ffffff',
  surface2: '#eff1f4',
  surface3: '#e4e7ec',
  surface4: '#d8dce3',
  surfaceHover: '#e4e7ec',
  inputBg: '#ffffff',
  border: 'rgba(19, 30, 43, 0.09)',
  borderSubtle: 'rgba(19, 30, 43, 0.065)',
  borderStrong: 'rgba(19, 30, 43, 0.18)',
  textPrimary: '#121418',
  textSecondary: '#4b5160',
  textMuted: '#5b6170',
  accent: '#367500',
  accentStrong: '#2d6200',
  accentPressed: '#255000',
  accentSubtle: 'rgba(54, 117, 0, 0.09)',
  accentMuted: 'rgba(54, 117, 0, 0.17)',
  onAccent: '#ffffff',
  success: '#047857',
  error: '#be123c',
  warning: '#c2410c'
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
