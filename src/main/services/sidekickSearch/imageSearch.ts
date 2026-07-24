import { nativeImage } from 'electron'
import { browserIdentity } from './browserIdentity'
import { SearchCache } from './cache'
import { fetchSearchDocument } from './searchHttp'
import type { ImageSearchOptions, ImageSearchResult } from './types'

interface DuckDuckGoImageItem {
  title?: string
  image?: string
  thumbnail?: string
  url?: string
  source?: string
  width?: number
  height?: number
}

interface DuckDuckGoImageResponse {
  results?: DuckDuckGoImageItem[]
}

const metadataCache = new SearchCache<ImageSearchResult[]>(10 * 60_000, 60)

function imageToken(html: string): string | undefined {
  return html.match(/vqd=["']([^"']+)/i)?.[1] || html.match(/vqd=([\d-]+)/i)?.[1]
}

export function normalizeImageResults(
  items: DuckDuckGoImageItem[],
  limit: number
): ImageSearchResult[] {
  const seen = new Set<string>()
  const results: ImageSearchResult[] = []
  for (const item of items) {
    const imageUrl = item.image?.trim() || ''
    const pageUrl = item.url?.trim() || ''
    if (!/^https?:\/\//.test(imageUrl) || !/^https?:\/\//.test(pageUrl) || seen.has(imageUrl)) {
      continue
    }
    seen.add(imageUrl)
    results.push({
      title: item.title?.trim() || 'Image result',
      imageUrl,
      thumbnailUrl: item.thumbnail?.trim() || imageUrl,
      pageUrl,
      source: item.source?.trim() || new URL(pageUrl).hostname,
      resolution:
        item.width && item.height
          ? `${Math.trunc(item.width)}×${Math.trunc(item.height)}`
          : undefined
    })
    if (results.length >= limit) break
  }
  return results
}

async function discoverImageMetadata(query: string, limit: number): Promise<ImageSearchResult[]> {
  const cacheKey = `${query.toLowerCase()}::${limit}`
  const cached = metadataCache.get(cacheKey)
  if (cached) return cached

  const controller = new AbortController()
  const searchPage = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`
  const html = await fetchSearchDocument(searchPage, controller.signal)
  const vqd = imageToken(html)
  if (!vqd) throw new Error('Image search session could not be established')

  const endpoint = new URL('https://duckduckgo.com/i.js')
  endpoint.search = new URLSearchParams({
    q: query,
    o: 'json',
    p: '1',
    s: '0',
    f: ',,,',
    l: 'us-en',
    vqd
  }).toString()
  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': browserIdentity(),
      Accept: 'application/json',
      Referer: searchPage
    },
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`Image search returned HTTP ${response.status}`)
  const payload = (await response.json()) as DuckDuckGoImageResponse
  const results = normalizeImageResults(payload.results || [], limit)
  if (results.length > 0) metadataCache.set(cacheKey, results)
  return results
}

function optimizeImage(
  rawBytes: Buffer,
  originalMimeType: string,
  maxBytes: number
): { bytes: Buffer; mimeType: string } | undefined {
  const image = nativeImage.createFromBuffer(rawBytes)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  if (!size.width || !size.height) return undefined
  const maxDimension = 768
  const scale = Math.min(1, maxDimension / Math.max(size.width, size.height))
  const resized =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale))
        })
      : image
  for (const quality of [72, 58, 44, 32]) {
    const jpeg = resized.toJPEG(quality)
    if (jpeg.length > 0 && jpeg.length <= maxBytes) {
      return { bytes: jpeg, mimeType: 'image/jpeg' }
    }
  }
  if (rawBytes.length <= maxBytes) return { bytes: rawBytes, mimeType: originalMimeType }
  return undefined
}

async function attachImageBytes(
  result: ImageSearchResult,
  maxBytes: number
): Promise<ImageSearchResult> {
  for (const candidate of [...new Set([result.thumbnailUrl, result.imageUrl])]) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'User-Agent': browserIdentity(),
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: result.pageUrl
        },
        signal: AbortSignal.timeout(12_000)
      })
      if (!response.ok) continue
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim()
      if (!mimeType.startsWith('image/')) continue
      const declaredLength = Number(response.headers.get('content-length') || 0)
      if (declaredLength > 8_000_000) continue
      const rawBytes = Buffer.from(await response.arrayBuffer())
      if (rawBytes.length === 0 || rawBytes.length > 8_000_000) continue
      const optimized = optimizeImage(rawBytes, mimeType, maxBytes)
      if (!optimized) continue
      return {
        ...result,
        imageBase64: optimized.bytes.toString('base64'),
        mimeType: optimized.mimeType
      }
    } catch {
      // Try the next candidate URL from the same result.
    }
  }
  return result
}

export async function searchImages(
  query: string,
  requestedLimit = 10,
  options: ImageSearchOptions = {}
): Promise<ImageSearchResult[]> {
  const cleanQuery = query.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!cleanQuery) throw new Error('Image search query is required')
  const limit = Math.max(1, Math.min(30, Math.trunc(requestedLimit)))
  const results = await discoverImageMetadata(cleanQuery, limit)
  if (!options.includeImageData || results.length === 0) return results

  const maxImages = Math.max(1, Math.min(4, options.maxImagesWithData ?? 2))
  const maxBytes = Math.max(150_000, Math.min(1_500_000, options.maxBytesPerImage ?? 350_000))
  const enriched = [...results]
  for (let index = 0; index < enriched.length && index < maxImages; index++) {
    enriched[index] = await attachImageBytes(enriched[index], maxBytes)
  }
  return enriched
}
