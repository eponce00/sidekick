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
  warning: '#e9a05f'
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
