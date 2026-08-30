import type { ContentSegment } from '../types/chat.types'

export interface ChangedFile {
  path: string
  kind: 'create' | 'update' | 'delete' | 'move'
  previousPath?: string
  diff: string
  additions: number
  deletions: number
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

function diffSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  const chunks = diff.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim())
  for (const chunk of chunks) {
    const path =
      chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1] ??
      chunk.match(/^diff --git\s+a\/.+?\s+b\/(.+)$/m)?.[1]
    if (path && path !== '/dev/null') sections.set(path.replace(/\\/g, '/'), chunk)
  }
  return sections
}

export function changedFilesFromSegments(segments: readonly ContentSegment[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  for (const segment of segments) {
    if (segment.type !== 'tool') continue
    const tool = segment.tool
    const changes = tool?.changes
    if (!tool || !changes?.length) continue
    const data = tool.data && typeof tool.data === 'object' ? tool.data as Record<string, unknown> : null
    const rawDiff = typeof data?.diff === 'string' ? data.diff : ''
    const sections = rawDiff ? diffSections(rawDiff) : new Map<string, string>()
    for (const change of changes) {
      const normalized = change.path.replace(/\\/g, '/')
      const selectedDiff =
        sections.get(normalized) ??
        (changes.length === 1 || sections.size === 0 ? rawDiff : '')
      const previous = files.get(normalized)
      const combinedDiff = [previous?.diff, selectedDiff].filter(Boolean).join('\n')
      files.set(normalized, {
        path: normalized,
        kind: change.kind,
        previousPath: change.previousPath ?? previous?.previousPath,
        diff: combinedDiff,
        ...diffStats(combinedDiff)
      })
    }
  }
  return [...files.values()]
}
