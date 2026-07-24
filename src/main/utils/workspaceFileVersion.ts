import { createHash } from 'crypto'

export interface WorkspaceFileStatVersion {
  size: number
  mtimeMs: number
  ino?: number
}

/** Opaque file identity used to reject edits based on stale model reads. */
export function workspaceFileVersion(stat: WorkspaceFileStatVersion): string {
  return createHash('sha256')
    .update(`${stat.size}:${stat.mtimeMs}:${stat.ino ?? 0}`)
    .digest('hex')
}
