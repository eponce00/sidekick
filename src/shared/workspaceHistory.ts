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
