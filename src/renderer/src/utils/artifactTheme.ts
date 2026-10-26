import {
  ARTIFACT_THEME_COLOR_KEYS,
  ARTIFACT_THEME_TOKENS,
  getArtifactFallbackTheme,
  getArtifactThemeCssVariables,
  type ArtifactTheme,
  type ArtifactThemeMode
} from '../../../shared/artifactTheme'

export {
  getArtifactFallbackTheme,
  getArtifactThemeCssVariables,
  type ArtifactTheme,
  type ArtifactThemeMode
}

function resolveCssColor(
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

/** The app's current look, as an artifact frame receives it. */
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
  const computed = doc.defaultView?.getComputedStyle(doc.body)

  const theme = { ...fallback }
  for (const [key, variableName] of ARTIFACT_THEME_TOKENS) {
    if (!ARTIFACT_THEME_COLOR_KEYS.has(key)) {
      // Fonts, sizes and radii go as written; only colors need resolving.
      theme[key] = computed?.getPropertyValue(variableName).trim() || fallback[key]
      continue
    }
    const property = key.startsWith('border')
      ? 'borderTopColor'
      : key.includes('Bg') || key.startsWith('surface') || key === 'background'
        ? 'backgroundColor'
        : 'color'
    theme[key] = resolveCssColor(resolver, variableName, property, fallback[key])
  }

  resolver.remove()
  return theme
}

/** Puts a theme on a frame's document. The page itself stays transparent: the chat shows through. */
export function applyArtifactTheme(doc: Document, theme: ArtifactTheme): void {
  const root = doc.documentElement
  for (const [name, value] of Object.entries(getArtifactThemeCssVariables(theme))) {
    root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme.themeMode
  root.dataset.theme = theme.themeMode
  if (doc.body) doc.body.dataset.theme = theme.themeMode
}

/**
 * The theme as a stylesheet, for a document that must have it before its own scripts run. Only
 * safe for a theme read by `readArtifactTheme`, whose values cannot end the rule or the element.
 */
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
  // Absent where nothing is displayed, as in tests.
  const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)')
  mediaQuery?.addEventListener('change', notify)

  return () => {
    observer.disconnect()
    mediaQuery?.removeEventListener('change', notify)
  }
}
