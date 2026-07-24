/**
 * Pure utility functions used by ChatPanel for URL sanitization,
 * provider detection, and model configuration.
 */
import type { ModelProvider } from '../../../shared/models'

export function toHttps(url: string): string {
  return url.startsWith('http://') ? url.replace(/^http:\/\//, 'https://') : url
}

export function getHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Edit distance with early exit: returns cap+1 if distance exceeds cap,
 * avoiding full O(m*n) work when strings are clearly too different.
 */
function editDistanceCapped(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const n = b.length
  const row = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const temp = row[j]
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1])
      prev = temp
      if (row[j] < rowMin) rowMin = row[j]
    }
    if (rowMin > cap) return cap + 1
  }
  return row[n]
}

/**
 * Finds the closest URL in the allowlist to the candidate (same domain, similarity >= threshold).
 * Returns the exact allowlist URL so broken/typo'd model URLs get replaced with the real one.
 */
export function findClosestAllowedUrl(
  candidate: string,
  allowedImageUrls: Set<string>,
  threshold = 0.85
): string | null {
  const candidateDomain = getHostname(candidate)
  if (!candidateDomain) return null
  let bestUrl: string | null = null
  let bestSimilarity = threshold
  for (const allowed of allowedImageUrls) {
    const normalised = toHttps(allowed)
    if (getHostname(normalised) !== candidateDomain) continue
    const maxLen = Math.max(candidate.length, normalised.length)
    if (maxLen === 0) continue
    const cap = Math.ceil(maxLen * (1 - threshold))
    const dist = editDistanceCapped(candidate, normalised, cap)
    const similarity = 1 - dist / maxLen
    if (similarity >= bestSimilarity) {
      bestSimilarity = similarity
      bestUrl = normalised
    }
  }
  return bestUrl
}

export function sanitizeAssistantImageMarkdown(
  content: string,
  allowedImageUrls: Set<string>
): { sanitized: string; blockedCount: number } {
  if (!content) return { sanitized: content, blockedCount: 0 }

  // Fix: model sometimes wraps the URL in an extra markdown link
  content = content.replace(/!\[([^\]]*)\]\(\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\)/g, '![$1]($3)')

  const allowedDomains = new Set<string>()
  for (const u of allowedImageUrls) {
    const h = getHostname(u)
    if (h) allowedDomains.add(h)
  }

  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  let blockedCount = 0
  const sanitized = content.replace(imageRegex, (_full, altText: string, url: string) => {
    const pipeIdx = url.indexOf('|')
    const baseUrl = pipeIdx !== -1 ? url.slice(0, pipeIdx) : url
    const httpsBase = toHttps(baseUrl)
    const pipeStr = pipeIdx !== -1 ? url.slice(pipeIdx) : ''

    // 1. Exact match
    if (
      allowedImageUrls.has(url) ||
      allowedImageUrls.has(toHttps(url)) ||
      allowedImageUrls.has(baseUrl) ||
      allowedImageUrls.has(httpsBase)
    ) {
      return `![${altText}](${httpsBase}${pipeStr})`
    }

    // 2. Same domain: swap in the exact allowlist URL if there's a close fuzzy match
    const domain = getHostname(httpsBase)
    if (domain && allowedDomains.has(domain)) {
      const closestUrl = findClosestAllowedUrl(httpsBase, allowedImageUrls)
      if (closestUrl) {
        return `![${altText}](${closestUrl}${pipeStr})`
      }
      blockedCount++
      console.warn('[Images] Blocked fabricated same-domain URL (no fuzzy match):', httpsBase)
      return ''
    }

    // 3. Unknown domain = model used a URL from training memory. Block it.
    blockedCount++
    console.warn('[Images] Blocked training-memory URL (not from search results):', httpsBase)
    return ''
  })
  return { sanitized, blockedCount }
}

// Provider helper utilities
export function getProviderFromModel(modelId: string): ModelProvider {
  if (modelId.startsWith('ollama-cloud:')) return 'ollama-cloud'
  if (modelId.startsWith('openrouter:')) return 'openrouter'
  if (modelId.startsWith('anthropic:')) return 'anthropic'
  if (modelId.startsWith('litellm:')) return 'litellm'
  if (modelId.startsWith('lmstudio:')) return 'lmstudio'
  if (modelId.startsWith('llamacpp:')) return 'llamacpp'
  return 'ollama'
}

export function stripModelPrefix(modelId: string): string {
  return modelId.replace(
    /^(ollama-cloud|ollama|openrouter|anthropic|litellm|lmstudio|llamacpp):/,
    ''
  )
}

export function stripThinkTags(text: string): string {
  return text.replace(/<\/?think>/g, '')
}

export const FAST_MODEL_CONTEXT_LIMIT = 24576
