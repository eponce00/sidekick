import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'

const iconCache = new Map<string, Promise<string | null>>()

export function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

function loadIcon(origin: string): Promise<string | null> {
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

/**
 * The linked site's icon, fetched once per origin from the site itself, with a
 * globe while loading or when the site has none.
 */
export function SiteIcon({ url, size = 14 }: { url: string; size?: number }): React.JSX.Element {
  const origin = originOf(url)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!origin) return
    let cancelled = false
    void loadIcon(origin).then((value) => {
      if (!cancelled) setDataUrl(value)
    })
    return () => {
      cancelled = true
    }
  }, [origin])

  if (!dataUrl)
    return <Globe className="site-icon site-icon-fallback" size={size} aria-hidden="true" />
  return (
    <img
      className="site-icon"
      src={dataUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      onError={() => setDataUrl(null)}
    />
  )
}
