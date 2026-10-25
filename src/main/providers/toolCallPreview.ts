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

/**
 * The `code` string of a create_artifact call whose JSON is still arriving, decoded as far as it
 * goes, or null before the field has begun. An escape cut off at the end waits for the next chunk.
 */
export function previewArtifactCode(raw: string): string | null {
  const start = /"code"\s*:\s*"/.exec(raw)
  if (!start) return null
  let end = start.index + start[0].length
  const from = end
  while (end < raw.length) {
    const char = raw[end]
    if (char === '"') break
    if (char === '\\') {
      const width = raw[end + 1] === 'u' ? 6 : 2
      if (end + width > raw.length) break
      end += width
    } else end++
  }
  try {
    return JSON.parse(`"${raw.slice(from, end)}"`) as string
  } catch {
    return null
  }
}

/** How often a streaming artifact's code is sent on, so the chat can show it taking shape. */
const ARTIFACT_DRAFT_INTERVAL_MS = 250

/**
 * Which previews of a reply's streaming tool calls are worth emitting: a call's small fields when
 * they change, and an artifact's code as it grows, at most every 250 ms. The code is decoded only
 * when due, so a long artifact costs one decode per interval rather than one per token.
 */
export class ToolCallPreviews {
  private readonly signatures = new Map<number, string>()
  private readonly drafts = new Map<number, { at: number; length: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** The preview to emit for this call now, or null when it adds nothing. */
  next(index: number, name: string, raw: string): Record<string, string> | null {
    if (!name) return null
    const preview = previewToolCallArguments(raw)
    const signature = `${name}\n${JSON.stringify(preview)}`
    let code: string | null = null
    if (name === 'create_artifact') {
      const draft = this.drafts.get(index)
      if (!draft || this.now() - draft.at >= ARTIFACT_DRAFT_INTERVAL_MS) {
        const decoded = previewArtifactCode(raw)
        if (decoded !== null && decoded.length > (draft?.length ?? 0)) {
          this.drafts.set(index, { at: this.now(), length: decoded.length })
          code = decoded
        }
      }
    }
    if (code === null && this.signatures.get(index) === signature) return null
    this.signatures.set(index, signature)
    return code === null ? preview : { ...preview, code }
  }

  forget(index: number): void {
    this.signatures.delete(index)
    this.drafts.delete(index)
  }
}
