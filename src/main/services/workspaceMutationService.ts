import { promises as fs } from 'fs'
import { basename, dirname, resolve } from 'path'
import {
  workspaceMutationTargetPaths,
  type WorkspaceFileChange,
  type WorkspaceMutationFailure,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult
} from '../../shared/workspaceMutations'
import {
  applyCanonicalUpdate,
  PatchApplicationError,
  parseCanonicalPatch
} from '../utils/canonicalPatch'
import { createWorkspaceFileChange } from '../utils/workspaceDiff'
import { credentialRedactor } from './credentialRedaction'
import { workspaceFileVersion } from '../utils/workspaceFileVersion'
import {
  OutsideProjectError,
  projectRelativePath,
  resolveSecureWorkspacePath,
  workspacePathKey
} from '../utils/workspacePaths'
import {
  DEFAULT_TEXT_FORMAT,
  decodeWorkspaceText,
  encodeWorkspaceText,
  type WorkspaceText,
  type WorkspaceTextFormat
} from '../utils/workspaceText'
import {
  describeMatchLocations,
  findLineBlockSpans,
  findNearMiss,
  reindentLineBlock,
  trimEditBoundaries
} from '../utils/lineBlockMatch'
import {
  carryOriginalCharacters,
  closestRegion,
  findTolerantSpans,
  stripReadLineNumbers,
  type TextSpan
} from '../utils/tolerantMatch'

interface PlannedChange {
  action: 'add' | 'update' | 'delete' | 'move'
  path: string
  absolutePath: string
  movePath?: string
  absoluteMovePath?: string
  /** The move changes only letter case, on a file system where both spellings name the file. */
  renameInPlace?: boolean
  /** Text for the diff; a file that is not text shows its bytes read as UTF-8. */
  before?: string
  after?: string
  /** The file's bytes when planned; present exactly when the file existed. */
  beforeBytes?: Buffer
  afterBytes?: Buffer
  beforeVersion?: string
}

/** An existing file: its bytes, and its text when it is text the tools can edit losslessly. */
interface FileContent {
  bytes: Buffer
  text?: WorkspaceText
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
  /**
   * Versions returned by the canonical read tool during this agent run, keyed by
   * `workspacePathKey` of the project-relative path.
   */
  expectedVersions?: Readonly<Record<string, string>>
  /** Require a matching receipt before changing or deleting an existing file. */
  requireReadReceipt?: boolean
}

interface FileSnapshot {
  path: string
  existed: boolean
  content?: Buffer
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
  return resolveSecureWorkspacePath(workspaceRoot, filePath, { rejectLinks: true })
}

function displayPath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

async function readOptional(path: string): Promise<FileContent | undefined> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error(`Path is not a regular file: ${path}`)
    const bytes = await fs.readFile(path)
    return { bytes, text: decodeWorkspaceText(bytes) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The text of an existing file a text edit will change, refusing what it would corrupt. */
function editableText(path: string, file: FileContent): WorkspaceText {
  if (file.text) return file.text
  throw new Error(
    `Edit rejected: ${path} is not UTF-8 or UTF-16 text, so a text edit would corrupt it; no file changes were made. Change it with a command that understands its format, or replace it whole with write.`
  )
}

/** Planned text for a file: its diff text and the bytes that will be written. */
function planned(text: string, format: WorkspaceTextFormat): { after: string; afterBytes: Buffer } {
  return { after: text, afterBytes: encodeWorkspaceText(text, format) }
}

/** The fields describing an existing file before the change. */
function existing(
  file: FileContent
): Pick<PlannedChange, 'before' | 'beforeBytes'> & { format: WorkspaceTextFormat } {
  return {
    before: file.text?.text ?? file.bytes.toString('utf8'),
    beforeBytes: file.bytes,
    format: file.text?.format ?? DEFAULT_TEXT_FORMAT
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

/** The line ending most lines of `content` use; a single stray CRLF does not convert LF files. */
function dominantLineEnding(content: string): '\n' | '\r\n' {
  const crlf = content.match(/\r\n/g)?.length ?? 0
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf ? '\r\n' : '\n'
}

function withLineEnding(text: string, ending: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, ending)
}

function adaptReplacementLineEndings(
  currentContent: string,
  oldText: string,
  newText: string
): { oldText: string; newText: string } {
  const ending = dominantLineEnding(currentContent)
  return { oldText: withLineEnding(oldText, ending), newText: withLineEnding(newText, ending) }
}

/** Replace each span (in ascending order) with the model's new text, keeping file characters. */
function replaceSpans(
  content: string,
  spans: readonly TextSpan[],
  modelOld: string,
  modelNew: string
): string {
  let result = ''
  let cursor = 0
  for (const span of spans) {
    const original = content.slice(span.start, span.end)
    const ending = original.includes('\r\n') ? '\r\n' : dominantLineEnding(content)
    const carried = carryOriginalCharacters(original, modelOld, modelNew)
    // Carried text already has the file's endings for kept lines; added lines get the span's.
    result +=
      content.slice(cursor, span.start) +
      (carried === undefined
        ? withLineEnding(modelNew, ending)
        : carried.replace(/\r?\n/g, (match) => (match === '\r\n' ? match : ending)))
    cursor = span.end
  }
  return result + content.slice(cursor)
}

const LOOSE_MATCH_NOTE =
  'Matching ignored indentation, inner whitespace and blank lines at the edges of old_string.'

function multipleMatchesError(
  path: string,
  content: string,
  matchCount: number,
  matchStartLines: number[],
  note = ''
): WorkspaceMutationPlanningError {
  const more = matchCount > matchStartLines.length ? ', …' : ''
  return new WorkspaceMutationPlanningError(
    `Edit rejected: old_string has ${matchCount} matches in ${path}; no file changes were made.` +
      (note ? ` ${note}` : '') +
      ` Match start lines: ${matchStartLines.join(', ')}${more}.\n` +
      `${describeMatchLocations(content, matchStartLines)}\n` +
      'Retry with replace_all=true only if every match should change; otherwise include surrounding lines in old_string so it matches once.',
    {
      code: 'multiple_matches',
      recovery:
        'Choose the replacement scope explicitly: set replace_all=true for every match, or add surrounding lines to old_string for one unique match. Do not repeat the unchanged call.',
      matchCount,
      matchStartLines
    }
  )
}

function notFoundError(
  path: string,
  content: string,
  oldText: string
): WorkspaceMutationPlanningError {
  const header = `Edit rejected: old_string was not found in ${path}; no file changes were made.`
  const nearMiss = findNearMiss(content, oldText)
  if (nearMiss) {
    const range = `${nearMiss.startLine}-${nearMiss.endLine}`
    return new WorkspaceMutationPlanningError(
      `${header}\nClosest match: file lines ${range}, where ${nearMiss.sameLines} of ${nearMiss.totalLines} old_string lines match (ignoring indentation and whitespace). These lines differ:\n` +
        `${nearMiss.differences.join('\n')}\n` +
        'old_string must copy the current file text. The file may have changed since that text was read, including through an earlier edit in this run.',
      {
        code: 'text_not_found',
        recovery: `Read lines ${range} of ${path} again, then retry with old_string copied from that text. Keep old_string to the lines that change plus a few lines of context; do not rewrite the whole file.`
      }
    )
  }
  const region = closestRegion(content, oldText)
  return new WorkspaceMutationPlanningError(
    header +
      (region
        ? `\nClosest current text (line numbers are for reference only; do not include them in old_string):\n${region}`
        : '') +
      '\nThe file may have changed since that text was read, including through an earlier edit in this run.',
    {
      code: 'text_not_found',
      recovery: region
        ? 'Copy old_string exactly from the closest current text above (without line numbers), or read the relevant range again, then retry once.'
        : 'Read the relevant range again and retry once with exact current text.'
    }
  )
}

/** Replace each span (in ascending order) with text built from the original span. */
function spliceSpans(
  content: string,
  spans: readonly TextSpan[],
  build: (original: string) => string
): string {
  let result = ''
  let cursor = 0
  for (const span of spans) {
    result += content.slice(cursor, span.start) + build(content.slice(span.start, span.end))
    cursor = span.end
  }
  return result + content.slice(cursor)
}

/** Extend spans over the line ending after them, so deleting lines leaves no blank line. */
function withFollowingLineEnding(content: string, spans: readonly TextSpan[]): TextSpan[] {
  return spans.map((span) => ({
    start: span.start,
    end: span.end + (/^\r?\n/.exec(content.slice(span.end, span.end + 2))?.[0].length ?? 0)
  }))
}

/**
 * Apply an edit whose old_string matched nowhere exactly. Each fallback is tried in order from
 * strictest to loosest, and the first that finds any match decides: one match (or replace_all)
 * is applied, several are rejected with their locations. A looser fallback is never consulted
 * to break a tie, so tolerance cannot move an edit to a location the model did not mean.
 */
function tolerantReplacement(
  path: string,
  before: string,
  request: Extract<WorkspaceMutationRequest, { kind: 'replace' }>
): string {
  const variants = [{ oldText: request.oldText, newText: request.newText }]
  // The model may have copied the read tool's `N: ` prefixes with the text.
  const unnumbered = stripReadLineNumbers(request.oldText)
  if (unnumbered !== undefined) {
    variants.push({
      oldText: unnumbered,
      newText: stripReadLineNumbers(request.newText) ?? request.newText
    })
  }
  for (const variant of variants) {
    const trimmed = trimEditBoundaries(variant.oldText, variant.newText)
    const edge = (spans: TextSpan[]): TextSpan[] =>
      trimmed?.droppedTrailingNewline && !trimmed.newText
        ? withFollowingLineEnding(before, spans)
        : spans
    const stages: Array<{
      find: () => TextSpan[]
      apply: (spans: TextSpan[]) => string
      note?: string
    }> = [
      {
        // Typography, trailing whitespace, line endings and invisible marks.
        find: () => findTolerantSpans(before, variant.oldText),
        apply: (spans) => replaceSpans(before, spans, variant.oldText, variant.newText)
      }
    ]
    if (trimmed) {
      stages.push({
        // Blank lines or a final newline at the edges of old_string that the file lacks there.
        find: () => edge(findTolerantSpans(before, trimmed.oldText)),
        apply: (spans) => replaceSpans(before, spans, trimmed.oldText, trimmed.newText)
      })
    }
    const lineOld = trimmed?.oldText ?? variant.oldText
    const lineNew = trimmed?.newText ?? variant.newText
    stages.push({
      // Whole lines retyped with different indentation or inner whitespace.
      find: () => edge(findLineBlockSpans(before, lineOld)),
      apply: (spans) =>
        spliceSpans(before, spans, (original) =>
          lineNew
            ? (reindentLineBlock(original, lineOld, lineNew) ??
              withLineEnding(lineNew, dominantLineEnding(before)))
            : ''
        ),
      note: LOOSE_MATCH_NOTE
    })
    for (const stage of stages) {
      const spans = stage.find()
      if (!spans.length) continue
      if (spans.length > 1 && !request.replaceAll) {
        throw multipleMatchesError(
          path,
          before,
          spans.length,
          spans.slice(0, 12).map((span) => before.slice(0, span.start).split('\n').length),
          stage.note
        )
      }
      return stage.apply(spans)
    }
  }
  throw notFoundError(path, before, request.oldText)
}

async function planSingleFileMutation(
  workspaceRoot: string,
  request: Exclude<WorkspaceMutationRequest, { kind: 'apply-patch' }>
): Promise<PlannedChange[]> {
  const relativePath = projectRelativePath(workspaceRoot, request.filePath)
  const absolutePath = await secureWorkspacePath(workspaceRoot, relativePath)
  const path = displayPath(relativePath)
  const current = await readOptional(absolutePath)
  const beforeVersion = await currentVersion(absolutePath)

  if (request.kind === 'delete') {
    if (current === undefined) throw new Error(`Cannot delete missing file: ${path}`)
    const { before, beforeBytes } = existing(current)
    return [{ action: 'delete', path, absolutePath, before, beforeBytes, beforeVersion }]
  }

  if (request.kind === 'write') {
    // Rewriting an existing text file keeps its encoding, byte order mark and line-ending
    // convention; models emit LF. A file that is not text is replaced as new UTF-8 text.
    const previous = current && existing(current)
    const content =
      current?.text && !request.content.includes('\r\n')
        ? withLineEnding(request.content, dominantLineEnding(current.text.text))
        : request.content
    const next = planned(content, previous?.format ?? DEFAULT_TEXT_FORMAT)
    if (current?.bytes.equals(next.afterBytes)) {
      throw new Error(`Write rejected: ${path} already has identical content`)
    }
    return [
      {
        action: current === undefined ? 'add' : 'update',
        path,
        absolutePath,
        before: previous?.before,
        beforeBytes: previous?.beforeBytes,
        ...next,
        beforeVersion
      }
    ]
  }

  if (request.oldText === request.newText) {
    throw new Error('Edit rejected: old_string and new_string are identical')
  }
  if (current === undefined) {
    if (request.oldText !== '') throw new Error(`Cannot edit missing file: ${path}`)
    return [{ action: 'add', path, absolutePath, ...planned(request.newText, DEFAULT_TEXT_FORMAT) }]
  }
  const { text: before, format } = editableText(path, current)
  const update = (after: string): PlannedChange[] => [
    {
      action: 'update',
      path,
      absolutePath,
      before,
      beforeBytes: current.bytes,
      ...planned(after, format),
      beforeVersion
    }
  ]
  if (request.oldText === '') {
    if (before !== '') {
      throw new Error(
        `Edit rejected: old_string may be empty only when creating a missing or empty file: ${path}`
      )
    }
    return update(request.newText)
  }

  const replacement = adaptReplacementLineEndings(before, request.oldText, request.newText)
  const occurrences = countOccurrences(before, replacement.oldText)
  if (!occurrences) {
    const after = tolerantReplacement(path, before, request)
    if (after === before)
      throw new Error(`Edit rejected: replacement produced no change in ${path}`)
    return update(after)
  }
  if (occurrences > 1 && !request.replaceAll) {
    throw multipleMatchesError(
      path,
      before,
      occurrences,
      occurrenceStartLines(before, replacement.oldText)
    )
  }
  const after = request.replaceAll
    ? before.split(replacement.oldText).join(replacement.newText)
    : before.replace(replacement.oldText, () => replacement.newText)
  if (after === before) throw new Error(`Edit rejected: replacement produced no change in ${path}`)
  return update(after)
}

/** Two paths that name one existing file, as two spellings do where names ignore case. */
async function sameFile(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([left, right].map((path) => fs.stat(path, { bigint: true })))
  return a.dev === b.dev && a.ino === b.ino
}

/** A patch that cannot be located in the file is a correctable input, like an edit's old_string. */
function patchApplicationFailure(error: unknown): unknown {
  if (!(error instanceof PatchApplicationError)) return error
  return new WorkspaceMutationPlanningError(error.message, {
    code: error.code,
    recovery:
      error.code === 'multiple_matches'
        ? 'Add surrounding unchanged lines to the hunk so it matches one place, then send one corrected patch.'
        : 'Copy the hunk context and removed lines exactly from the current file text (read the range again if needed), then send one corrected patch.'
  })
}

async function planCanonicalPatch(
  workspaceRoot: string,
  request: Extract<WorkspaceMutationRequest, { kind: 'apply-patch' }>
): Promise<PlannedChange[]> {
  const operations = parseCanonicalPatch(request.patch)
  const changes: PlannedChange[] = []
  const touchedAbsolutePaths = new Set<string>()
  const claimPath = (absolutePath: string): void => {
    const key = workspacePathKey(absolutePath)
    if (touchedAbsolutePaths.has(key)) {
      throw new Error(`Patch rejected: resolved path is modified more than once: ${absolutePath}`)
    }
    touchedAbsolutePaths.add(key)
  }
  for (const operation of operations) {
    const relativePath = projectRelativePath(workspaceRoot, operation.path)
    const absolutePath = await secureWorkspacePath(workspaceRoot, relativePath)
    claimPath(absolutePath)
    const path = displayPath(relativePath)
    const current = await readOptional(absolutePath)
    const beforeVersion = await currentVersion(absolutePath)
    if (operation.type === 'add') {
      if (current !== undefined) throw new Error(`Patch rejected: Add File already exists: ${path}`)
      changes.push({
        action: 'add',
        path,
        absolutePath,
        ...planned(operation.content, DEFAULT_TEXT_FORMAT)
      })
      continue
    }
    if (operation.type === 'delete') {
      if (current === undefined) throw new Error(`Patch rejected: Delete File is missing: ${path}`)
      const { before, beforeBytes } = existing(current)
      changes.push({ action: 'delete', path, absolutePath, before, beforeBytes, beforeVersion })
      continue
    }
    if (current === undefined) throw new Error(`Patch rejected: Update File is missing: ${path}`)
    const { text: before, format } = editableText(path, current)
    let after: string
    try {
      after = applyCanonicalUpdate(before, operation)
    } catch (error) {
      throw patchApplicationFailure(error)
    }
    const change = {
      path,
      absolutePath,
      before,
      beforeBytes: current.bytes,
      ...planned(after, format),
      beforeVersion
    }
    if (operation.movePath) {
      const relativeMovePath = projectRelativePath(workspaceRoot, operation.movePath)
      const absoluteMovePath = await secureWorkspacePath(workspaceRoot, relativeMovePath)
      // Where names ignore case, a rename that changes only case names the same file.
      const renameInPlace =
        absoluteMovePath !== absolutePath &&
        workspacePathKey(absoluteMovePath) === workspacePathKey(absolutePath)
      if (!renameInPlace) claimPath(absoluteMovePath)
      const movePath = displayPath(relativeMovePath)
      if (
        (await readOptional(absoluteMovePath)) !== undefined &&
        !(renameInPlace && (await sameFile(absolutePath, absoluteMovePath)))
      ) {
        throw new Error(`Patch rejected: Move destination already exists: ${movePath}`)
      }
      changes.push({
        ...change,
        action: 'move',
        movePath,
        absoluteMovePath,
        ...(renameInPlace ? { renameInPlace } : {})
      })
    } else {
      changes.push({ ...change, action: 'update' })
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
    if (change.beforeBytes === undefined) continue
    const expected = receipts[workspacePathKey(displayPath(change.path))]
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
        `Stale read receipt for ${change.path}: the file changed after it was last read, so text copied from that read may no longer match. Re-read the file and retry.`,
        {
          code: 'stale_read',
          recovery: 'The file changed after it was read. Re-read it and rebuild the mutation.'
        }
      )
    }
  }
}

/** The read-receipt error for the request's existing target files, if any. */
async function readReceiptProblem(
  workspaceRoot: string,
  request: WorkspaceMutationRequest,
  options: WorkspaceMutationExecutionOptions
): Promise<Error | undefined> {
  if (!options.requireReadReceipt) return undefined
  for (const target of workspaceMutationTargetPaths(request)) {
    try {
      const relativePath = projectRelativePath(workspaceRoot, target)
      const absolutePath = await secureWorkspacePath(workspaceRoot, relativePath)
      const beforeVersion = await currentVersion(absolutePath)
      if (beforeVersion === undefined) continue
      verifyReadReceipts(
        [
          {
            action: 'update',
            path: displayPath(relativePath),
            absolutePath,
            beforeBytes: Buffer.alloc(0),
            beforeVersion
          }
        ],
        options
      )
    } catch (error) {
      if (error instanceof WorkspaceMutationPlanningError) return error
    }
  }
  return undefined
}

async function planMutation(
  workspaceRoot: string,
  request: WorkspaceMutationRequest
): Promise<PlannedChange[]> {
  refuseSecretPlaceholders(request)
  return request.kind === 'apply-patch'
    ? planCanonicalPatch(workspaceRoot, request)
    : planSingleFileMutation(workspaceRoot, request)
}

/**
 * The agent reads a stored credential in a file as `[secret: alias]`. Writing that text back
 * would replace the real value with the placeholder, so no change may contain one.
 */
function refuseSecretPlaceholders(request: WorkspaceMutationRequest): void {
  const text =
    request.kind === 'apply-patch'
      ? request.patch
      : request.kind === 'replace'
        ? `${request.oldText}\n${request.newText}`
        : request.kind === 'write'
          ? request.content
          : ''
  if (!credentialRedactor.placeholders(text)) return
  throw new WorkspaceMutationPlanningError(
    'Edit rejected: it contains a [secret: …] placeholder. Where you read one, the file holds the stored value it hides, and writing the placeholder would replace that value. No file changes were made.',
    {
      code: 'secret_placeholder',
      recovery:
        'Change only lines that do not show a [secret: …] placeholder, with edits that leave those lines out, or ask the user to change the stored value themselves.'
    }
  )
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
    ...(error instanceof WorkspaceMutationPlanningError
      ? { failure: error.failure }
      : error instanceof OutsideProjectError
        ? { failure: { code: 'outside_project', recovery: 'Use a path inside the project.' } }
        : {})
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.stat(path)
    // Bytes, not text: a rollback must give back a file that is not UTF-8 unchanged.
    return { path, existed: true, content: await fs.readFile(path), mode: stat.mode }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, existed: false }
    throw error
  }
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  for (const item of [...snapshots].reverse()) {
    if (item.existed) {
      await fs.mkdir(dirname(item.path), { recursive: true })
      await fs.writeFile(item.path, item.content ?? Buffer.alloc(0))
      if (item.mode !== undefined) await fs.chmod(item.path, item.mode)
    } else {
      await fs.rm(item.path, { force: true })
    }
  }
}

async function hasBytes(path: string, expected: Buffer | undefined): Promise<boolean> {
  const file = await readOptional(path)
  return file !== undefined && expected !== undefined && file.bytes.equals(expected)
}

async function verifyChange(change: PlannedChange): Promise<void> {
  if (change.action === 'delete') {
    if ((await readOptional(change.absolutePath)) !== undefined) {
      throw new Error(`Verification failed: ${change.path} still exists`)
    }
    return
  }
  if (change.action === 'move') {
    const destination = change.absoluteMovePath!
    const sourceGone = change.renameInPlace
      ? (await fs.readdir(dirname(destination))).includes(basename(destination))
      : (await readOptional(change.absolutePath)) === undefined
    if (!sourceGone) {
      throw new Error(`Verification failed: move source still exists: ${change.path}`)
    }
    if (!(await hasBytes(destination, change.afterBytes))) {
      throw new Error(`Verification failed: move destination content differs: ${change.movePath}`)
    }
    return
  }
  if (!(await hasBytes(change.absolutePath, change.afterBytes))) {
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
    const unchanged = source.content
      ? change.beforeBytes?.equals(source.content) === true
      : change.beforeBytes === undefined
    if (!unchanged) {
      throw new Error(`Mutation became stale before commit: ${change.path}; re-read the file`)
    }
    if (
      change.absoluteMovePath &&
      !change.renameInPlace &&
      snapshotsByPath.get(change.absoluteMovePath)?.existed
    ) {
      throw new Error(`Mutation became stale before commit: ${change.movePath} now exists`)
    }
  }
  const createdDirectories = new Set<string>()
  const modifiedPaths = new Set<string>()
  const renamed: PlannedChange[] = []
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
      } else if (change.renameInPlace) {
        modifiedPaths.add(change.absolutePath)
        await fs.writeFile(change.absolutePath, change.afterBytes!)
        await fs.rename(change.absolutePath, change.absoluteMovePath!)
        renamed.push(change)
      } else if (change.action === 'move') {
        await ensureParent(change.absoluteMovePath!)
        const source = await fs.stat(change.absolutePath)
        const destination = await fs.open(change.absoluteMovePath!, 'wx', source.mode & 0o777)
        modifiedPaths.add(change.absoluteMovePath!)
        try {
          await destination.writeFile(change.afterBytes!)
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
          await file.writeFile(change.afterBytes!)
          await file.sync()
        } finally {
          await file.close()
        }
      } else {
        await ensureParent(change.absolutePath)
        modifiedPaths.add(change.absolutePath)
        await fs.writeFile(change.absolutePath, change.afterBytes!)
      }
    }
    for (const change of changes) await verifyChange(change)
  } catch (error) {
    try {
      for (const change of renamed.reverse()) {
        await fs.rename(change.absoluteMovePath!, change.absolutePath)
      }
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
      let changes: PlannedChange[]
      try {
        changes = await planMutation(workspaceRoot, request)
      } catch (error) {
        // Text that no longer matches is usually a symptom of a stale read; report the cause.
        throw (await readReceiptProblem(workspaceRoot, request, options)) ?? error
      }
      verifyReadReceipts(changes, options)
      await applyPlan(changes)
      return resultFromChanges(changes)
    } catch (error) {
      return failure(error)
    }
  })
}
