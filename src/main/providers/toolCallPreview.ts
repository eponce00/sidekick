const PREVIEW_FIELDS = [
  'file_path',
  'path',
  'title',
  'type',
  'query',
  'url',
  'regex',
  'sub_path',
  'glob'
] as const

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

/**
 * Extracts only small, presentation-safe fields from a tool's incomplete JSON input.
 * Streaming the complete cumulative input on every token would be quadratic for large
 * file writes, so providers publish this preview until the final tool call is ready.
 */
export function previewToolCallArguments(raw: string): Record<string, string> {
  const preview: Record<string, string> = {}
  for (const field of PREVIEW_FIELDS) {
    const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
    if (match?.[1] !== undefined) preview[field] = decodeJsonString(match[1])
  }
  return preview
}
