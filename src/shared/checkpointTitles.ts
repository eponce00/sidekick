export const CHECKPOINT_TITLE_VERSION = 1
export const CHECKPOINT_TITLE_BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000

export const CHECKPOINT_TITLE_SOURCES = ['legacy', 'fallback', 'generated', 'user'] as const

export type CheckpointTitleSource = (typeof CHECKPOINT_TITLE_SOURCES)[number]

export interface CheckpointHistoryItem {
  hash: string
  message: string
  timestamp: number
  workspaceRoot: string
  titleSource: CheckpointTitleSource
  titleVersion: number
  changeCount?: number
  captureVersion?: number
}

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

export interface HistoryStatus {
  storage: 'private-app-data'
  realRepository: boolean
  appliedHash: string | null
}

export interface CheckpointListResult {
  ok: boolean
  checkpoints: CheckpointHistoryItem[]
  status?: HistoryStatus
  error?: string
}

export interface CheckpointTitleIdentity {
  workspaceRoot: string
  hash: string
  expectedTitle: string
}

export interface CompleteCheckpointTitleBackfillInput extends CheckpointTitleIdentity {
  title: string
}

export interface FailCheckpointTitleBackfillInput extends CheckpointTitleIdentity {
  error: string
}

export interface CheckpointTitleContext {
  userContent: string
  assistantContent: string
}

export function checkpointTitleVersionForSource(source: CheckpointTitleSource): number {
  return source === 'generated' || source === 'user' ? CHECKPOINT_TITLE_VERSION : 0
}

export function isCheckpointTitleSource(value: unknown): value is CheckpointTitleSource {
  return (
    typeof value === 'string' && (CHECKPOINT_TITLE_SOURCES as readonly string[]).includes(value)
  )
}
