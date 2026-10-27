const iconCache = new Map<string, Promise<string | null>>()

/** A site's icon as a data URL, asked of the main process once per origin. */
export function loadSiteIcon(origin: string): Promise<string | null> {
  let pending = iconCache.get(origin)
  if (!pending) {
    pending = window.api.siteIcons
      .get(origin)
      .then((result) => result.dataUrl)
      .catch(() => null)
    iconCache.set(origin, pending)
  }
  return pending
}
