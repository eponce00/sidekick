// Pure utility functions for message formatting and display

/**
 * Formats a timestamp into a relative time string
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Human-readable relative time string (e.g., "5m ago", "2h ago", "3:45 PM")
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`

  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** Estimates tokens from visible message text when providers do not report per-message usage. */
export function estimateVisibleMessageTokens(content: string): number {
  const trimmed = content.trim()
  if (!trimmed) return 0
  const words = trimmed.split(/\s+/).filter(Boolean).length
  return Math.max(words, Math.ceil(trimmed.length / 4))
}

/**
 * Checks if an artifact tag is still open (unclosed) in the content
 * @param content - Message content string to check
 * @returns true if there's an open artifact tag, false otherwise
 */
export function isArtifactOpen(content: string): boolean {
  const openCount = content.match(/<artifact\b/g)?.length ?? 0
  const closeCount = content.match(/<\/artifact>/g)?.length ?? 0
  return openCount > closeCount
}
