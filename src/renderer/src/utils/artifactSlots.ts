import type { ContentSegment } from '../types/chat.types'
import type { ParsedArtifact } from './artifactParser'

/**
 * Where each artifact in a reply shows, and as what. A model that fixes, revises or edits an
 * artifact makes it again under the same title; the reply shows it once, in the place it first
 * appeared, as its latest version, so a change replaces it where it is instead of stacking a new
 * copy further down. While an edit runs, the slot keeps the current version and says it is
 * changing. Every other segment of that artifact shows nothing.
 */
export function artifactSlots(
  segments: readonly ContentSegment[]
): Map<ContentSegment, ParsedArtifact | null> {
  const slots = new Map<ContentSegment, ParsedArtifact | null>()
  const firstByTitle = new Map<string, ContentSegment>()
  let latestTitle: string | null = null
  for (const segment of segments) {
    const artifact = segment.type === 'artifact' ? segment.artifact : undefined
    if (!artifact) continue
    // An edit that names no artifact changes the latest one.
    const title = artifact.editing && !artifact.title ? latestTitle : artifact.title
    const first = title === null ? undefined : firstByTitle.get(title)
    if (!first) {
      // An edit of an artifact from an earlier reply shows once it has made the new version.
      slots.set(segment, artifact.editing ? null : artifact)
      if (artifact.editing) continue
      firstByTitle.set(artifact.title, segment)
      latestTitle = artifact.title
      continue
    }
    const current = slots.get(first)!
    slots.set(segment, null)
    slots.set(
      first,
      artifact.editing
        ? { ...current, isStreaming: true, editing: true, slotKey: current.slotKey }
        : { ...artifact, slotKey: current.slotKey ?? current.toolCallId }
    )
    latestTitle = title
  }
  return slots
}
