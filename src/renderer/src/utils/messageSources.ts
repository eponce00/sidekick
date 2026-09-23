/**
 * External links cited in a reply, deduplicated by host in order of first
 * appearance, for the "Sources" row under a message.
 */
export interface MessageSource {
  url: string
  host: string
  /** Link text the model gave it, when it was a markdown link with a label. */
  label?: string
}

const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /(?<!\w)https?:\/\/[^\s<>)"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?'"»)\]]+$/

function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

export function extractMessageSources(markdown: string, limit = 12): MessageSource[] {
  const text = stripCode(markdown)
  const byHost = new Map<string, MessageSource>()
  const consider = (rawUrl: string, label?: string): void => {
    const url = rawUrl.replace(TRAILING_PUNCTUATION, '')
    const host = hostOf(url)
    if (!host || byHost.has(host)) return
    const trimmedLabel = label?.trim()
    byHost.set(host, {
      url,
      host,
      ...(trimmedLabel && trimmedLabel !== url && !/^https?:\/\//.test(trimmedLabel)
        ? { label: trimmedLabel }
        : {})
    })
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) consider(match[2], match[1])
  // Labelled links are consumed before the bare scan so their URL is not seen twice.
  for (const match of text.replace(MARKDOWN_LINK, ' ').matchAll(BARE_URL)) consider(match[0])
  return [...byHost.values()].slice(0, limit)
}
