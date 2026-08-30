export const CHECKPOINT_TITLE_VERSION = 2
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

const META_CHECKPOINT_TITLE =
  /\b(?:the user wants|user wants|create an imperative|imperative workspace|workspace checkpoint|checkpoint label|create a label)\b/i
const GENERIC_CHECKPOINT_TITLES = new Set([
  'changes',
  'continue',
  'project changes',
  'sidekick changes',
  'update files',
  'update project'
])

/** Accept only concise, outcome-oriented labels from the background title model. */
export function normalizeCheckpointTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?:;,]+$/g, '')
    .replace(/\s+/g, ' ')
  if (!title || title.length > 72 || title.split(' ').length > 7) return null
  if (META_CHECKPOINT_TITLE.test(title) || GENERIC_CHECKPOINT_TITLES.has(title.toLowerCase())) {
    return null
  }
  return title
}

function humanizeCheckpointPath(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/$/, '').split('/').filter(Boolean)
  let value = parts.at(-1) || 'project files'
  const stem = value.replace(/\.[^.]+$/, '')
  if (/^(?:index|main|app)$/i.test(stem) && parts.length > 1) value = parts.at(-2) || stem
  else value = stem
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase())
}

/** Provides a useful label immediately, without depending on model quality or availability. */
export function checkpointFallbackTitleFromPaths(paths: readonly string[]): string {
  const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
  if (unique.length === 0) return 'Update project files'
  if (unique.length === 1) return `Update ${humanizeCheckpointPath(unique[0])}`

  const names = unique
    .map(humanizeCheckpointPath)
    .filter(
      (name, index, all) =>
        all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index
    )
  if (names.length === 1) return `Update ${names[0]} files`
  if (names.length === 2) return `Update ${names[0]} and ${names[1]}`.slice(0, 72)

  const topFolders = [...new Set(unique.map((path) => path.replace(/\\/g, '/').split('/')[0]))]
  if (topFolders.length === 1 && topFolders[0] && !['src', 'app', 'lib'].includes(topFolders[0])) {
    return `Update ${humanizeCheckpointPath(topFolders[0])} files`
  }
  return `Update ${unique.length} project files`
}

export function checkpointFallbackTitleFromDiff(diff: string): string {
  const paths = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2])
  return checkpointFallbackTitleFromPaths(paths)
}
