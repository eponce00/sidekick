import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import type {
  WorkspaceFileChange,
  WorkspaceMutationFailure,
  WorkspaceMutationRequest,
  WorkspaceMutationResult
} from '../../shared/workspaceMutations'
import { applyCanonicalUpdate, parseCanonicalPatch } from '../utils/canonicalPatch'
import { createWorkspaceFileChange } from '../utils/workspaceDiff'
import { workspaceFileVersion } from '../utils/workspaceFileVersion'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'

interface PlannedChange {
  action: 'add' | 'update' | 'delete' | 'move'
  path: string
  absolutePath: string
  movePath?: string
  absoluteMovePath?: string
  before?: string
  after?: string
  beforeVersion?: string
}

class WorkspaceMutationPlanningError extends Error {
  constructor(
    message: string,
    readonly failure: WorkspaceMutationFailure
  ) {
    super(message)
    this.name = 'WorkspaceMutationPlanningError'
  }
}

export interface WorkspaceMutationExecutionOptions {
  /** Versions returned by read_workspace_file during this agent run. */
  expectedVersions?: Readonly<Record<string, string>>
  /** Require a matching receipt before changing or deleting an existing file. */
  requireReadReceipt?: boolean
}

interface FileSnapshot {
  path: string
  existed: boolean
  content?: string
  mode?: number
}

const workspaceQueues = new Map<string, Promise<void>>()

async function withWorkspaceLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const resolvedRoot = resolve(workspaceRoot)
  const key = await fs.realpath(resolvedRoot).catch(() => resolvedRoot)
  const previous = workspaceQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  const queued = previous.then(() => current)
  workspaceQueues.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (workspaceQueues.get(key) === queued) workspaceQueues.delete(key)
  }
}

async function secureWorkspacePath(workspaceRoot: string, filePath: string): Promise<string> {
  if (!filePath.trim()) throw new Error('file_path is required')
  return resolveSecureWorkspacePath(workspaceRoot, filePath, { rejectSymlinks: true })
}

function displayPath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error(`Path is not a regular file: ${path}`)
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function currentVersion(path: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile() ? workspaceFileVersion(stat) : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while ((index = content.indexOf(needle, index)) >= 0) {
    count++
    index += needle.length
  }
  return count
}

function occurrenceStartLines(content: string, needle: string, limit = 12): number[] {
  if (!needle) return []
  const lines: number[] = []
  let index = 0
  while (lines.length < limit && (index = content.indexOf(needle, index)) >= 0) {
    lines.push(content.slice(0, index).split('\n').length)
    index += needle.length
  }
  return lines
}

function adaptReplacementLineEndings(
  currentContent: string,
  oldText: string,
  newText: string
): { oldText: string; newText: string } {
  if (currentContent.includes('\r\n')) {
    return {
      oldText: oldText.replace(/\r?\n/g, '\r\n'),
      newText: newText.replace(/\r?\n/g, '\r\n')
    }
  }
  return {
    oldText: oldText.replace(/\r\n/g, '\n'),
    newText: newText.replace(/\r\n/g, '\n')
  }
}

async function planSingleFileMutation(
  workspaceRoot: string,
  request: Exclude<WorkspaceMutationRequest, { kind: 'apply-patch' }>
): Promise<PlannedChange[]> {
  const absolutePath = await secureWorkspacePath(workspaceRoot, request.filePath)
  const path = displayPath(request.filePath)
  const before = await readOptional(absolutePath)
  const beforeVersion = await currentVersion(absolutePath)

  if (request.kind === 'delete') {
    if (before === undefined) throw new Error(`Cannot delete missing file: ${path}`)
    return [{ action: 'delete', path, absolutePath, before, beforeVersion }]
  }

  if (request.kind === 'write') {
    if (before === request.content)
      throw new Error(`Write rejected: ${path} already has identical content`)
    return [
      {
        action: before === undefined ? 'add' : 'update',
        path,
        absolutePath,
        before,
        after: request.content,
        beforeVersion
      }
    ]
  }

  if (request.oldText === request.newText) {
    throw new Error('Edit rejected: old_string and new_string are identical')
  }
  if (before === undefined) {
    if (request.oldText !== '') throw new Error(`Cannot edit missing file: ${path}`)
    return [{ action: 'add', path, absolutePath, after: request.newText }]
  }
  if (request.oldText === '') {
    if (before !== '') {
      throw new Error(
        `Edit rejected: old_string may be empty only when creating a missing or empty file: ${path}`
      )
    }
    return [{ action: 'update', path, absolutePath, before, after: request.newText, beforeVersion }]
  }

  const replacement = adaptReplacementLineEndings(before, request.oldText, request.newText)
  const occurrences = countOccurrences(before, replacement.oldText)
  if (!occurrences) {
    throw new WorkspaceMutationPlanningError(
      `Edit rejected: old_string was not found in ${path}; no file changes were made`,
      {
        code: 'text_not_found',
        recovery: 'Re-read the relevant range and retry once with exact current text.'
      }
    )
  }
  if (occurrences > 1 && !request.replaceAll) {
    const matchStartLines = occurrenceStartLines(before, replacement.oldText)
    const lineSummary = matchStartLines.length
      ? ` Match start lines: ${matchStartLines.join(', ')}${occurrences > matchStartLines.length ? ', …' : ''}.`
      : ''
    throw new WorkspaceMutationPlanningError(
      `Edit rejected: old_string has ${occurrences} matches in ${path}; no file changes were made.${lineSummary} Retry with replace_all=true only if every match should change; otherwise include surrounding lines in old_string so it matches once.`,
      {
        code: 'multiple_matches',
        recovery:
          'Choose the replacement scope explicitly: set replace_all=true for every match, or add surrounding lines to old_string for one unique match. Do not repeat the unchanged call.',
        matchCount: occurrences,
        matchStartLines
      }
    )
  }
  const after = request.replaceAll
    ? before.split(replacement.oldText).join(replacement.newText)
    : before.replace(replacement.oldText, replacement.newText)
  if (after === before) throw new Error(`Edit rejected: replacement produced no change in ${path}`)
  return [{ action: 'update', path, absolutePath, before, after, beforeVersion }]
}

async function planCanonicalPatch(
  workspaceRoot: string,
  request: Extract<WorkspaceMutationRequest, { kind: 'apply-patch' }>
): Promise<PlannedChange[]> {
  const operations = parseCanonicalPatch(request.patch)
  const changes: PlannedChange[] = []
  const touchedAbsolutePaths = new Set<string>()
  const claimPath = (absolutePath: string): void => {
    const key = process.platform === 'linux' ? absolutePath : absolutePath.toLocaleLowerCase()
    if (touchedAbsolutePaths.has(key)) {
      throw new Error(`Patch rejected: resolved path is modified more than once: ${absolutePath}`)
    }
    touchedAbsolutePaths.add(key)
  }
  for (const operation of operations) {
    const absolutePath = await secureWorkspacePath(workspaceRoot, operation.path)
    claimPath(absolutePath)
    const path = displayPath(operation.path)
    const before = await readOptional(absolutePath)
    const beforeVersion = await currentVersion(absolutePath)
    if (operation.type === 'add') {
      if (before !== undefined) throw new Error(`Patch rejected: Add File already exists: ${path}`)
      changes.push({ action: 'add', path, absolutePath, after: operation.content })
      continue
    }
    if (operation.type === 'delete') {
      if (before === undefined) throw new Error(`Patch rejected: Delete File is missing: ${path}`)
      changes.push({ action: 'delete', path, absolutePath, before, beforeVersion })
      continue
    }
    if (before === undefined) throw new Error(`Patch rejected: Update File is missing: ${path}`)
    const after = applyCanonicalUpdate(before, operation)
    if (operation.movePath) {
      const absoluteMovePath = await secureWorkspacePath(workspaceRoot, operation.movePath)
      claimPath(absoluteMovePath)
      const movePath = displayPath(operation.movePath)
      if ((await readOptional(absoluteMovePath)) !== undefined) {
        throw new Error(`Patch rejected: Move destination already exists: ${movePath}`)
      }
      changes.push({
        action: 'move',
        path,
        absolutePath,
        movePath,
        absoluteMovePath,
        before,
        after,
        beforeVersion
      })
    } else {
      changes.push({ action: 'update', path, absolutePath, before, after, beforeVersion })
    }
  }
  return changes
}

function verifyReadReceipts(
  changes: PlannedChange[],
  options: WorkspaceMutationExecutionOptions
): void {
  if (!options.requireReadReceipt) return
  const receipts = options.expectedVersions ?? {}
  for (const change of changes) {
    if (change.before === undefined) continue
    const expected = receipts[displayPath(change.path)]
    if (!expected) {
      throw new WorkspaceMutationPlanningError(
        `Read receipt required before changing ${change.path}; read the file and retry`,
        {
          code: 'read_required',
          recovery: 'Read the affected file, then retry once against that exact version.'
        }
      )
    }
    if (expected !== change.beforeVersion) {
      throw new WorkspaceMutationPlanningError(
        `Stale read receipt for ${change.path}; re-read the file and retry`,
        {
          code: 'stale_read',
          recovery: 'The file changed after it was read. Re-read it and rebuild the mutation.'
        }
      )
    }
  }
}

async function planMutation(
  workspaceRoot: string,
  request: WorkspaceMutationRequest
): Promise<PlannedChange[]> {
  return request.kind === 'apply-patch'
    ? planCanonicalPatch(workspaceRoot, request)
    : planSingleFileMutation(workspaceRoot, request)
}

function publicChanges(changes: PlannedChange[]): WorkspaceFileChange[] {
  return changes.map((change) =>
    createWorkspaceFileChange({
      path: change.path,
      action: change.action,
      movePath: change.movePath,
      before: change.before,
      after: change.after
    })
  )
}

function resultFromChanges(changes: PlannedChange[]): WorkspaceMutationResult {
  const files = publicChanges(changes)
  const completeDiff = files.map((file) => file.diff).join('\n\n')
  const diffTruncated = files.some((file) => file.diffTruncated) || completeDiff.length > 128_000
  return {
    ok: true,
    changed: files.length > 0,
    files,
    diff:
      completeDiff.length > 128_000
        ? `${completeDiff.slice(0, 128_000)}\n... aggregate diff preview truncated ...`
        : completeDiff,
    diffTruncated: diffTruncated || undefined,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  }
}

function failure(error: unknown): WorkspaceMutationResult {
  return {
    ok: false,
    changed: false,
    files: [],
    diff: '',
    additions: 0,
    deletions: 0,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof WorkspaceMutationPlanningError ? { failure: error.failure } : {})
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.stat(path)
    return { path, existed: true, content: await fs.readFile(path, 'utf8'), mode: stat.mode }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, existed: false }
    throw error
  }
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  for (const item of [...snapshots].reverse()) {
    if (item.existed) {
      await fs.mkdir(dirname(item.path), { recursive: true })
      await fs.writeFile(item.path, item.content ?? '', 'utf8')
      if (item.mode !== undefined) await fs.chmod(item.path, item.mode)
    } else {
      await fs.rm(item.path, { force: true })
    }
  }
}

async function verifyChange(change: PlannedChange): Promise<void> {
  if (change.action === 'delete') {
    if ((await readOptional(change.absolutePath)) !== undefined) {
      throw new Error(`Verification failed: ${change.path} still exists`)
    }
    return
  }
  if (change.action === 'move') {
    if ((await readOptional(change.absolutePath)) !== undefined) {
      throw new Error(`Verification failed: move source still exists: ${change.path}`)
    }
    if ((await readOptional(change.absoluteMovePath!)) !== change.after) {
      throw new Error(`Verification failed: move destination content differs: ${change.movePath}`)
    }
    return
  }
  if ((await readOptional(change.absolutePath)) !== change.after) {
    throw new Error(`Verification failed: written content differs for ${change.path}`)
  }
}

async function applyPlan(changes: PlannedChange[]): Promise<void> {
  const paths = new Set<string>()
  for (const change of changes) {
    paths.add(change.absolutePath)
    if (change.absoluteMovePath) paths.add(change.absoluteMovePath)
  }
  const snapshots = await Promise.all([...paths].map(snapshot))
  const snapshotsByPath = new Map(snapshots.map((item) => [item.path, item]))
  for (const change of changes) {
    const source = snapshotsByPath.get(change.absolutePath)!
    if (source.content !== change.before) {
      throw new Error(`Mutation became stale before commit: ${change.path}; re-read the file`)
    }
    if (change.absoluteMovePath && snapshotsByPath.get(change.absoluteMovePath)?.existed) {
      throw new Error(`Mutation became stale before commit: ${change.movePath} now exists`)
    }
  }
  const createdDirectories = new Set<string>()
  const modifiedPaths = new Set<string>()
  const ensureParent = async (path: string): Promise<void> => {
    const missing: string[] = []
    let current = dirname(path)
    while (true) {
      try {
        await fs.lstat(current)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(current)
        const parent = dirname(current)
        if (parent === current) throw error
        current = parent
      }
    }
    for (const directory of missing) createdDirectories.add(directory)
    await fs.mkdir(dirname(path), { recursive: true })
  }
  try {
    for (const change of changes) {
      if (change.action === 'delete') {
        modifiedPaths.add(change.absolutePath)
        await fs.unlink(change.absolutePath)
      } else if (change.action === 'move') {
        await ensureParent(change.absoluteMovePath!)
        const source = await fs.stat(change.absolutePath)
        const destination = await fs.open(change.absoluteMovePath!, 'wx', source.mode & 0o777)
        modifiedPaths.add(change.absoluteMovePath!)
        try {
          await destination.writeFile(change.after!, 'utf8')
          await destination.sync()
        } finally {
          await destination.close()
        }
        modifiedPaths.add(change.absolutePath)
        await fs.unlink(change.absolutePath)
      } else if (change.action === 'add') {
        await ensureParent(change.absolutePath)
        const file = await fs.open(change.absolutePath, 'wx')
        modifiedPaths.add(change.absolutePath)
        try {
          await file.writeFile(change.after!, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
      } else {
        await ensureParent(change.absolutePath)
        modifiedPaths.add(change.absolutePath)
        await fs.writeFile(change.absolutePath, change.after!, 'utf8')
      }
    }
    for (const change of changes) await verifyChange(change)
  } catch (error) {
    try {
      await restoreSnapshots(snapshots.filter((item) => modifiedPaths.has(item.path)))
      for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
        try {
          await fs.rmdir(directory)
        } catch (directoryError) {
          if (
            !['ENOENT', 'ENOTEMPTY'].includes((directoryError as NodeJS.ErrnoException).code || '')
          ) {
            throw directoryError
          }
        }
      }
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    throw error
  }
}

export async function previewWorkspaceMutation(
  workspaceRoot: string,
  request: WorkspaceMutationRequest
): Promise<WorkspaceMutationResult> {
  return withWorkspaceLock(workspaceRoot, async () => {
    try {
      return resultFromChanges(await planMutation(workspaceRoot, request))
    } catch (error) {
      return failure(error)
    }
  })
}

export async function executeWorkspaceMutation(
  workspaceRoot: string,
  request: WorkspaceMutationRequest,
  options: WorkspaceMutationExecutionOptions = {}
): Promise<WorkspaceMutationResult> {
  return withWorkspaceLock(workspaceRoot, async () => {
    try {
      const changes = await planMutation(workspaceRoot, request)
      verifyReadReceipts(changes, options)
      await applyPlan(changes)
      return resultFromChanges(changes)
    } catch (error) {
      return failure(error)
    }
  })
}
