export type MapProvider = 'google' | 'apple' | 'openstreetmap'

export interface MapCoordinates {
  latitude: number
  longitude: number
}

export interface MapLinkLocation {
  href: string
  provider: MapProvider
  providerLabel: string
  label: string
  query?: string
  coordinates?: MapCoordinates
  zoom?: number
  embedUrl?: string
}

function decoded(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim() || undefined
  } catch {
    return value.replace(/\+/g, ' ').trim() || undefined
  }
}

function numericPair(value: string | null | undefined): MapCoordinates | undefined {
  if (!value) return undefined
  const match = value.match(/(-?\d{1,2}(?:\.\d+)?)[,/]\s*(-?\d{1,3}(?:\.\d+)?)/)
  if (!match) return undefined
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined
  }
  return { latitude, longitude }
}

function coordinatesFromGoogleUrl(url: URL): MapCoordinates | undefined {
  const pathMatch = url.pathname.match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/)
  return pathMatch
    ? numericPair(`${pathMatch[1]},${pathMatch[2]}`)
    : numericPair(
        url.searchParams.get('ll') ||
          url.searchParams.get('center') ||
          url.searchParams.get('query') ||
          url.searchParams.get('q')
      )
}

function zoomFromGoogleUrl(url: URL): number | undefined {
  const raw = url.pathname.match(/,([0-9]+(?:\.[0-9]+)?)z(?:\/|$)/)?.[1]
  const zoom = raw ? Number(raw) : undefined
  return zoom && Number.isFinite(zoom) ? Math.min(20, Math.max(2, Math.round(zoom))) : undefined
}

function pathQuery(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean)
  const kindIndex = parts.findIndex((part) => part === 'place' || part === 'search')
  return kindIndex >= 0 ? decoded(parts[kindIndex + 1]) : undefined
}

function usefulFallbackLabel(label: string): string | undefined {
  const normalized = label.trim()
  return /^(?:google|apple|openstreetmap)?\s*maps?$/i.test(normalized)
    ? undefined
    : normalized || undefined
}

function googleEmbedUrl(
  coordinates: MapCoordinates | undefined,
  query: string | undefined,
  zoom: number
): string | undefined {
  const target = coordinates ? `${coordinates.latitude},${coordinates.longitude}` : query
  if (!target) return undefined
  const params = new URLSearchParams({ q: target, z: String(zoom), output: 'embed' })
  return `https://www.google.com/maps?${params.toString()}`
}

function googleLocation(url: URL, href: string, label: string): MapLinkLocation {
  const coordinates = coordinatesFromGoogleUrl(url)
  const query =
    decoded(url.searchParams.get('query') || url.searchParams.get('q')) ||
    pathQuery(url) ||
    usefulFallbackLabel(label)
  const zoom = zoomFromGoogleUrl(url) || 15
  return {
    href,
    provider: 'google',
    providerLabel: 'Google Maps',
    label: query || label || 'Map location',
    query,
    coordinates,
    zoom,
    embedUrl: googleEmbedUrl(coordinates, query, zoom)
  }
}

function appleLocation(url: URL, href: string, label: string): MapLinkLocation {
  const coordinates = numericPair(
    url.searchParams.get('ll') || url.searchParams.get('center') || url.searchParams.get('sll')
  )
  const query = decoded(url.searchParams.get('q') || url.searchParams.get('address'))
  return {
    href,
    provider: 'apple',
    providerLabel: 'Apple Maps',
    label: query || usefulFallbackLabel(label) || 'Map location',
    query,
    coordinates,
    zoom: 15
  }
}

function openStreetMapLocation(url: URL, href: string, label: string): MapLinkLocation {
  const hashMatch = url.hash.match(
    /#map=([0-9]+(?:\.[0-9]+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/
  )
  const coordinates = hashMatch
    ? numericPair(`${hashMatch[2]},${hashMatch[3]}`)
    : numericPair(
        [url.searchParams.get('mlat'), url.searchParams.get('mlon')].filter(Boolean).join(',')
      )
  const zoom = hashMatch ? Number(hashMatch[1]) : 15
  return {
    href,
    provider: 'openstreetmap',
    providerLabel: 'OpenStreetMap',
    label: usefulFallbackLabel(label) || 'Map location',
    coordinates,
    zoom: Number.isFinite(zoom) ? Math.min(20, Math.max(2, Math.round(zoom))) : 15
  }
}

export function parseMapLink(href: string, label = ''): MapLinkLocation | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (
    (host === 'google.com' && url.pathname.startsWith('/maps')) ||
    host === 'maps.google.com' ||
    host === 'maps.app.goo.gl' ||
    (host === 'goo.gl' && url.pathname.startsWith('/maps'))
  ) {
    return googleLocation(url, href, label)
  }
  if (host === 'maps.apple.com') return appleLocation(url, href, label)
  if (host === 'openstreetmap.org') return openStreetMapLocation(url, href, label)
  return null
}
