export interface HistoryCaptureResult {
  ok: boolean
  captureId: string | null
  error?: string
}

export interface HistoryConflict {
  path: string
  reason: 'changed-after' | 'staged-in-git' | 'unsupported-file'
}

export interface HistoryMutationResult {
  ok: boolean
  changedFiles?: number
  conflicts?: HistoryConflict[]
  error?: string
}

/** One folder's History point for a reply: the reply's changes there, in that folder's history. */
export interface HistoryPoint {
  workspaceRoot: string
  hash: string
}

/**
 * How a folder's files go back: to before the earliest of these points (oldest first) that is
 * still on the folder's History timeline, which undoes it and everything after it. A point
 * already undone is passed over; a folder none of whose points is left needs no restoring.
 */
export interface HistoryRestoreTarget {
  workspaceRoot: string
  hashes: string[]
}

/** Parses a stored list of History points, dropping anything malformed. */
export function parseHistoryPoints(value: unknown): HistoryPoint[] {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (point): point is HistoryPoint =>
      Boolean(point) &&
      typeof point === 'object' &&
      typeof (point as HistoryPoint).workspaceRoot === 'string' &&
      typeof (point as HistoryPoint).hash === 'string' &&
      /^[0-9a-f]{7,64}$/i.test((point as HistoryPoint).hash)
  )
}

/**
 * How each project folder goes back to before the message at `index`: before the first of the
 * History points from that message on that is still on the folder's timeline. Folders no reply
 * from there on changed are left as they are.
 */
export function historyRestoreTargets(
  messages: ReadonlyArray<{ checkpoints?: readonly HistoryPoint[] }>,
  index: number,
  folderRoots: readonly string[]
): HistoryRestoreTarget[] {
  const later = messages.slice(index)
  return [...new Set(folderRoots)].flatMap((root) => {
    const hashes = later.flatMap(
      ({ checkpoints }) =>
        checkpoints
          ?.filter(({ workspaceRoot }) => workspaceRoot === root)
          .map(({ hash }) => hash) ?? []
    )
    return hashes.length ? [{ workspaceRoot: root, hashes }] : []
  })
}
