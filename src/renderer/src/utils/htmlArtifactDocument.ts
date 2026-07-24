import artifactSandboxCss from '../styles/artifactSandbox.css?raw'
import {
  createArtifactThemeStyle,
  getArtifactThemeCssVariables,
  type ArtifactTheme
} from './artifactTheme'

function normalizeHtmlDocument(code: string): string {
  const trimmed = code.trim()
  if (/<html[\s>]/i.test(trimmed)) return trimmed

  const doctype = trimmed.match(/^<!doctype[^>]*>/i)?.[0] || '<!DOCTYPE html>'
  const body = trimmed.replace(/^<!doctype[^>]*>/i, '').trim()
  return `${doctype}
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
${body}
</body>
</html>`
}

function serializedTheme(theme: ArtifactTheme): string {
  return JSON.stringify({
    mode: theme.themeMode,
    variables: getArtifactThemeCssVariables(theme)
  }).replace(/</g, '\\u003c')
}

export function buildArtifactSrcDoc(code: string, theme: ArtifactTheme): string {
  const themeStyle = `<style id="sidekick-artifact-theme">${createArtifactThemeStyle(theme)}\n${artifactSandboxCss}</style>`
  let normalizedHtml = normalizeHtmlDocument(code)
  normalizedHtml = /<head[\s>]/i.test(normalizedHtml)
    ? normalizedHtml.replace(/<head([^>]*)>/i, `<head$1>\n${themeStyle}`)
    : normalizedHtml.replace(/<html([^>]*)>/i, `<html$1>\n<head>${themeStyle}</head>`)
  const helperScript = `
<script>
(() => {
  const applyTheme = (payload) => {
    if (!payload || !payload.variables) return
    const root = document.documentElement
    Object.entries(payload.variables).forEach(([name, value]) => root.style.setProperty(name, String(value)))
    const mode = payload.mode === 'light' ? 'light' : 'dark'
    root.dataset.theme = mode
    root.style.colorScheme = mode
    if (document.body) document.body.dataset.theme = mode
  }

  applyTheme(${serializedTheme(theme)})

  const postHeight = () => {
    const body = document.body
    const doc = document.documentElement
    const height = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      120
    )

    parent.postMessage({ type: 'html-artifact-height', height }, '*')
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'html-artifact-theme') return
    applyTheme(event.data.theme)
    requestAnimationFrame(postHeight)
  })

  window.addEventListener('error', (event) => {
    parent.postMessage({ type: 'html-artifact-error', error: event.message || 'HTML artifact error' }, '*')
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
    parent.postMessage({ type: 'html-artifact-error', error: reason }, '*')
  })

  window.addEventListener('load', () => {
    postHeight()
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => postHeight())
      if (document.body) observer.observe(document.body)
      if (document.documentElement) observer.observe(document.documentElement)
    }
    window.addEventListener('resize', postHeight)
    setTimeout(postHeight, 0)
  })
})()
</script>`

  if (/<\/body>/i.test(normalizedHtml)) {
    return normalizedHtml.replace(/<\/body>/i, `${helperScript}\n</body>`)
  }

  return `${normalizedHtml}\n${helperScript}`
}
