/**
 * The tallest an artifact grows inside a reply. Taller content scrolls inside it at this height
 * and opens full screen whole. Two screens of a typical window: room for a dashboard, not a page.
 */
export const MAX_ARTIFACT_FRAME_HEIGHT = 1_600
/** The height an artifact holds while it first renders: one quiet line. */
export const PENDING_ARTIFACT_FRAME_HEIGHT = 40

export function boundedArtifactFrameHeight(
  contentHeight: number,
  maxHeight = MAX_ARTIFACT_FRAME_HEIGHT
): number {
  if (!Number.isFinite(contentHeight) || contentHeight < 0) return PENDING_ARTIFACT_FRAME_HEIGHT
  return Math.min(maxHeight, Math.ceil(contentHeight))
}

// The last height each artifact rendered at, so one shown again, as when a chat is reopened or a
// panel remounts, holds its place from the start instead of growing into it.
const REMEMBERED_LIMIT = 200
const remembered = new Map<string, number>()

function artifactKey(kind: string, code: string): string {
  // FNV-1a: a short key for code that can be large.
  let hash = 0x811c9dc5
  for (let index = 0; index < code.length; index++) {
    hash ^= code.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${kind}:${code.length}:${(hash >>> 0).toString(36)}`
}

export function rememberArtifactHeight(kind: string, code: string, height: number): void {
  const key = artifactKey(kind, code)
  remembered.delete(key)
  remembered.set(key, height)
  if (remembered.size > REMEMBERED_LIMIT) {
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
}

export function rememberedArtifactHeight(kind: string, code: string): number | null {
  return remembered.get(artifactKey(kind, code)) ?? null
}
