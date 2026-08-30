/**
 * Resolve a development renderer asset without allowing a protocol path to
 * replace the configured renderer origin (for example, with `//169.254...`).
 */
export function resolveDevelopmentArtifactUrl(
  rendererUrl: string,
  pathname: string,
  search = ''
): URL | null {
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (
    pathname.startsWith('//') ||
    decodedPathname.startsWith('//') ||
    pathname.includes('\\') ||
    decodedPathname.includes('\\')
  ) {
    return null
  }

  try {
    const rendererBase = new URL(rendererUrl)
    const target = new URL(pathname + search, rendererBase)
    return target.origin === rendererBase.origin ? target : null
  } catch {
    return null
  }
}
