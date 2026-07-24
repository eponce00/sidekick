export interface ParsedArtifact {
  type: 'react' | 'html' | 'svg'
  title: string
  code: string
  isStreaming?: boolean
}

export interface ParsedMessage {
  segments: MessageSegment[]
}

export interface MessageSegment {
  type: 'text' | 'artifact'
  content?: string
  artifact?: ParsedArtifact
}

const parseArtifactAttributes = (rawAttributes: string): Record<string, string> => {
  const attributes: Record<string, string> = {}
  const attrRegex = /(\w+)=["']([^"']*)["']/g
  let attrMatch
  while ((attrMatch = attrRegex.exec(rawAttributes)) !== null) {
    attributes[attrMatch[1]] = attrMatch[2]
  }
  return attributes
}

/**
 * Parses a message content string and extracts artifacts.
 * Returns an array of segments that alternate between text and artifacts.
 * Handles both complete and incomplete (streaming) artifacts.
 */
export function parseMessageWithArtifacts(content: string): ParsedMessage {
  const segments: MessageSegment[] = []

  // Match complete artifacts with flexible attributes
  const completeArtifactRegex = /<artifact\s+([^>]+)>([\s\S]*?)<\/artifact>/g

  let lastIndex = 0
  let match

  // First, find all complete artifacts
  while ((match = completeArtifactRegex.exec(content)) !== null) {
    // Add text segment before this artifact (if any)
    const textBefore = content.slice(lastIndex, match.index).trim()
    if (textBefore) {
      segments.push({ type: 'text', content: textBefore })
    }

    // Add complete artifact segment
    const attributes = parseArtifactAttributes(match[1])
    const type = attributes.type as ParsedArtifact['type'] | undefined
    if (type) {
      segments.push({
        type: 'artifact',
        artifact: {
          type,
          title: attributes.title || 'Artifact',
          code: match[2].trim(),
          isStreaming: false
        }
      })
    } else {
      segments.push({ type: 'text', content: match[0] })
    }

    lastIndex = match.index + match[0].length
  }

  // Check for incomplete artifact at the end (streaming)
  const remainingContent = content.slice(lastIndex)
  const openTagRegex = /<artifact\s+([^>]+)>/g
  let openMatch: RegExpExecArray | null = null
  let currentMatch
  while ((currentMatch = openTagRegex.exec(remainingContent)) !== null) {
    openMatch = currentMatch
  }

  if (openMatch) {
    const closeIndex = remainingContent.indexOf('</artifact>', openMatch.index)
    if (closeIndex === -1) {
      const textBefore = remainingContent.slice(0, openMatch.index).trim()
      if (textBefore) {
        segments.push({ type: 'text', content: textBefore })
      }

      const attributes = parseArtifactAttributes(openMatch[1])
      const type = attributes.type as ParsedArtifact['type'] | undefined
      if (type) {
        segments.push({
          type: 'artifact',
          artifact: {
            type,
            title: attributes.title || 'Artifact',
            code: remainingContent.slice(openMatch.index + openMatch[0].length).trim(),
            isStreaming: true
          }
        })
        return { segments }
      }
    }
  }

  // Add remaining text after the last artifact (if any)
  const textAfter = remainingContent.trim()
  if (textAfter) {
    segments.push({ type: 'text', content: textAfter })
  }

  // If no artifacts found, return the whole content as a single text segment
  if (segments.length === 0 && content.trim()) {
    segments.push({ type: 'text', content: content })
  }

  return { segments }
}

/**
 * Checks if a message contains any artifacts (complete or streaming)
 */
export function hasArtifacts(content: string): boolean {
  return /<artifact\s+[^>]*type=["'](\w+)["']/.test(content)
}

/**
 * Checks if a message has a streaming (incomplete) artifact
 */
export function hasStreamingArtifact(content: string): boolean {
  const hasOpenTag = /<artifact\s+[^>]*type=["'](\w+)["']/.test(content)
  const closeTagCount = (content.match(/<\/artifact>/g) || []).length
  const openTagCount = (content.match(/<artifact\s+[^>]*type=["'](\w+)["']/g) || []).length
  return hasOpenTag && openTagCount > closeTagCount
}
