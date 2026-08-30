/**
 * Private workspace history.
 *
 * Git is used only as a content-addressed storage engine. The repository lives
 * in SideKick's application data, never inside the project, and every command
 * receives an explicit GIT_DIR/GIT_WORK_TREE pair. A project's real .git
 * directory, HEAD, branches, index, stash, and reflog are never mutated.
 *
 * History v2 captures a tree immediately before a SideKick tool run and a tree
 * after it. The commit records the baseline tree, so user edits that existed
 * before the run are context rather than changes owned by that history entry.
 * Restore walks those per-run deltas and refuses to overwrite files that no
 * longer match the state SideKick left behind or that are staged in real Git.
 */

import { createHash, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import type {
  HistoryConflict,
  HistoryMutationResult,
  HistoryStatus
} from '../../shared/checkpointTitles'

const execFileAsync = promisify(execFile)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const HISTORY_VERSION = 2
const CAPTURE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FILES = 10_000
const MAX_GIT_OUTPUT = 50 * 1024 * 1024
const HISTORY_BRANCH = 'refs/heads/checkpoints'
const APPLIED_REF = 'refs/sidekick/applied'

const MANAGED_EXCLUDES = [
  '/.sidekick/checkpoints.git/',
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  '__pycache__/',
  '.venv/',
  '.env',
  '.env.*',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.key'
] as const

export interface Checkpoint {
  hash: string
  message: string
  timestamp: number
  workspaceRoot: string
  changeCount?: number
  captureVersion?: number
}

export interface CreatedCheckpoint {
  hash: string
  changeCount: number
  captureVersion: number
  changedPaths: string[]
}

interface CaptureSession {
  id: string
  workspaceRoot: string
  baseTree: string
  conversationId: string
  agentMessageId: string
  createdAt: number
}

export interface RecoveredCheckpointCapture {
  conversationId: string
  agentMessageId: string
  workspaceRoot: string
  checkpoint: CreatedCheckpoint
}

interface CommitMetadata {
  baseTree: string
  captureVersion: number
  changeCount?: number
}

interface TreeState {
  oid: string
  mode: string
}

interface RestoreOperation {
  path: string
  expectedTree: string
  desiredTree: string
  expected: TreeState | null
  desired: TreeState | null
}

interface CoordinatedRewindPlan {
  workspaceRoot: string
  checkpointHash: string
  previousBranch: string | null
  previousApplied: string
  parentHash: string | null
  operations: RestoreOperation[]
}

export interface CoordinatedRewindTarget {
  workspaceRoot: string
  checkpointHash: string
}

export interface CoordinatedHistoryConflict extends HistoryConflict {
  workspaceRoot: string
}

export type CoordinatedRewindResult =
  | {
      ok: true
      workspaces: Array<{
        workspaceRoot: string
        checkpointHash: string
        parentHash: string | null
        changedFiles: number
      }>
    }
  | { ok: false; conflicts: CoordinatedHistoryConflict[] }

let historyStorageRoot: string | null = null
const captureSessions = new Map<string, CaptureSession>()

export function configureCheckpointStorageRoot(root: string): void {
  historyStorageRoot = resolve(root)
}

function configuredStorageRoot(): string {
  if (!historyStorageRoot) throw new Error('History storage is not configured')
  return historyStorageRoot
}

function workspaceKey(workspaceRoot: string): string {
  return createHash('sha256').update(resolve(workspaceRoot)).digest('hex')
}

function shadowDir(workspaceRoot: string): string {
  return join(configuredStorageRoot(), workspaceKey(workspaceRoot), 'checkpoints.git')
}

function legacyShadowDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.sidekick', 'checkpoints.git')
}

function textOutput(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value
}

async function git(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_DIR: shadowDir(workspaceRoot),
      GIT_WORK_TREE: workspaceRoot
    },
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true
  })
  return textOutput(stdout).trim()
}

async function realGit(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true
  })
  return textOutput(stdout).trim()
}

async function ref(workspaceRoot: string, name: string): Promise<string | null> {
  try {
    return (await git(workspaceRoot, ['rev-parse', '--verify', name])) || null
  } catch {
    return null
  }
}

async function updateRef(workspaceRoot: string, name: string, hash: string | null): Promise<void> {
  if (hash) await git(workspaceRoot, ['update-ref', name, hash])
  else {
    try {
      await git(workspaceRoot, ['update-ref', '-d', name])
    } catch {
      // Missing refs are already in the desired state.
    }
  }
}

async function migrateLegacyRepo(workspaceRoot: string, destination: string): Promise<void> {
  const legacy = legacyShadowDir(workspaceRoot)
  try {
    await fs.access(join(legacy, 'HEAD'))
  } catch {
    return
  }
  try {
    await fs.access(join(destination, 'HEAD'))
    return
  } catch {
    // The private destination is empty; migrate below.
  }

  await fs.mkdir(dirname(destination), { recursive: true })
  try {
    await fs.rename(legacy, destination)
  } catch {
    await fs.cp(legacy, destination, { recursive: true, force: false })
    await fs.rm(legacy, { recursive: true, force: true })
  }
}

async function writeManagedExcludes(dir: string): Promise<void> {
  const excludeFile = join(dir, 'info', 'exclude')
  await fs.mkdir(dirname(excludeFile), { recursive: true })
  let existing = ''
  try {
    existing = await fs.readFile(excludeFile, 'utf8')
  } catch {
    // New repository.
  }
  const begin = '# SideKick managed history excludes'
  const end = '# End SideKick managed history excludes'
  const withoutManaged = existing.replace(
    new RegExp(
      `${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
      'g'
    ),
    ''
  )
  // Remove the legacy blanket rule. SideKick project rules may legitimately
  // live in .sidekick and should be recoverable like other project files.
  const preserved = withoutManaged
    .split(/\r?\n/)
    .filter((line) => !['.sidekick', '.sidekick/'].includes(line.trim()))
    .join('\n')
    .trimEnd()
  const managed = [begin, ...MANAGED_EXCLUDES, end].join('\n')
  await fs.writeFile(excludeFile, `${preserved ? `${preserved}\n` : ''}${managed}\n`, 'utf8')
}

export async function checkGitAvailable(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'])
    return textOutput(stdout).trim()
  } catch {
    return null
  }
}

export async function initShadowRepo(workspaceRoot: string): Promise<void> {
  const root = resolve(workspaceRoot)
  const dir = shadowDir(root)
  await migrateLegacyRepo(root, dir)
  await fs.mkdir(dir, { recursive: true })

  try {
    await fs.access(join(dir, 'HEAD'))
  } catch {
    await execFileAsync('git', ['init', '--bare', '--object-format=sha1', dir], {
      windowsHide: true
    })
    const env = { ...process.env, GIT_DIR: dir, GIT_WORK_TREE: root }
    await execFileAsync('git', ['config', 'user.email', 'sidekick@localhost'], {
      cwd: root,
      env,
      windowsHide: true
    })
    await execFileAsync('git', ['config', 'user.name', 'SideKick History'], {
      cwd: root,
      env,
      windowsHide: true
    })
    await execFileAsync('git', ['config', 'core.autocrlf', 'false'], {
      cwd: root,
      env,
      windowsHide: true
    })
    await execFileAsync('git', ['config', 'core.longpaths', 'true'], {
      cwd: root,
      env,
      windowsHide: true
    })
  }
  await writeManagedExcludes(dir)

  const tip = await ref(root, HISTORY_BRANCH)
  if (tip && !(await ref(root, APPLIED_REF))) await updateRef(root, APPLIED_REF, tip)
}

async function gatherWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    '__pycache__',
    '.venv'
  ])
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const rel = relative(workspaceRoot, fullPath).split(sep).join('/')
      if (rel === '.sidekick/checkpoints.git' || rel.startsWith('.sidekick/checkpoints.git/')) {
        continue
      }
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(rel)
        if (files.length > MAX_FILES) {
          throw new Error(
            `WORKSPACE_TOO_LARGE: Workspace has more than ${MAX_FILES} files — history capture skipped`
          )
        }
      }
    }
  }

  await walk(workspaceRoot)
  return files
}

async function writeWorkspaceTree(workspaceRoot: string): Promise<string> {
  await initShadowRepo(workspaceRoot)
  await gatherWorkspaceFiles(workspaceRoot)
  await git(workspaceRoot, ['add', '--all', '--', '.'])
  try {
    await git(workspaceRoot, [
      'rm',
      '--cached',
      '-r',
      '--ignore-unmatch',
      '.sidekick/checkpoints.git'
    ])
  } catch {
    // Legacy history was not present in the index.
  }
  return git(workspaceRoot, ['write-tree'])
}

function captureMetadataPath(captureId: string): string {
  return join(configuredStorageRoot(), 'captures', `${captureId}.json`)
}

async function persistCapture(capture: CaptureSession): Promise<void> {
  const directory = join(configuredStorageRoot(), 'captures')
  await fs.mkdir(directory, { recursive: true })
  const destination = captureMetadataPath(capture.id)
  const temporary = `${destination}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(capture), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, destination)
  await updateRef(capture.workspaceRoot, `refs/sidekick/captures/${capture.id}`, capture.baseTree)
}

async function loadPersistedCapture(captureId: string): Promise<CaptureSession | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(captureMetadataPath(captureId), 'utf8')
    ) as Partial<CaptureSession>
    if (
      parsed.id !== captureId ||
      typeof parsed.workspaceRoot !== 'string' ||
      !/^[0-9a-f]{40,64}$/i.test(parsed.baseTree || '') ||
      typeof parsed.conversationId !== 'string' ||
      typeof parsed.agentMessageId !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null
    }
    return parsed as CaptureSession
  } catch {
    return null
  }
}

async function removeCapture(capture: CaptureSession): Promise<void> {
  captureSessions.delete(capture.id)
  await fs.rm(captureMetadataPath(capture.id), { force: true })
  await updateRef(capture.workspaceRoot, `refs/sidekick/captures/${capture.id}`, null)
}

async function pruneCaptures(): Promise<void> {
  const threshold = Date.now() - CAPTURE_TTL_MS
  for (const capture of captureSessions.values()) {
    if (capture.createdAt < threshold) await removeCapture(capture)
  }
  try {
    const directory = join(configuredStorageRoot(), 'captures')
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith('.json')) continue
      const capture = await loadPersistedCapture(entry.slice(0, -5))
      if (capture && capture.createdAt < threshold) await removeCapture(capture)
    }
  } catch {
    // No persisted captures yet.
  }
}

export async function beginCheckpointCapture(
  workspaceRoot: string,
  conversationId: string,
  agentMessageId: string
): Promise<string> {
  await pruneCaptures()
  const root = resolve(workspaceRoot)
  const capture: CaptureSession = {
    id: randomUUID(),
    workspaceRoot: root,
    baseTree: await writeWorkspaceTree(root),
    conversationId,
    agentMessageId,
    createdAt: Date.now()
  }
  captureSessions.set(capture.id, capture)
  try {
    await persistCapture(capture)
  } catch (error) {
    captureSessions.delete(capture.id)
    throw error
  }
  return capture.id
}

export async function discardCheckpointCapture(captureId: string): Promise<void> {
  const capture = captureSessions.get(captureId) ?? (await loadPersistedCapture(captureId))
  if (capture) await removeCapture(capture)
}

async function changedPaths(
  workspaceRoot: string,
  fromTree: string,
  toTree: string
): Promise<string[]> {
  const output = await git(workspaceRoot, [
    '--literal-pathspecs',
    'diff',
    '--name-only',
    '-z',
    fromTree,
    toTree,
    '--'
  ])
  return output.split('\0').filter(Boolean)
}

async function commitMetadata(workspaceRoot: string, hash: string): Promise<CommitMetadata> {
  const body = await git(workspaceRoot, ['show', '-s', '--format=%B', hash])
  const base = body.match(/^SideKick-Base-Tree:\s*([0-9a-f]{40,64})\s*$/im)?.[1]
  const version = Number.parseInt(
    body.match(/^SideKick-History-Version:\s*(\d+)\s*$/im)?.[1] || '1',
    10
  )
  const countText = body.match(/^SideKick-Changed-Files:\s*(\d+)\s*$/im)?.[1]
  if (base) {
    return {
      baseTree: base,
      captureVersion: Number.isFinite(version) ? version : HISTORY_VERSION,
      changeCount: countText ? Number.parseInt(countText, 10) : undefined
    }
  }
  const parent = await ref(workspaceRoot, `${hash}^`)
  return { baseTree: parent ?? EMPTY_TREE, captureVersion: 1 }
}

export async function createCheckpoint(
  workspaceRoot: string,
  message: string,
  captureId?: string
): Promise<CreatedCheckpoint | null> {
  const root = resolve(workspaceRoot)
  const capture = captureId
    ? (captureSessions.get(captureId) ?? (await loadPersistedCapture(captureId)) ?? undefined)
    : undefined
  if (captureId && (!capture || capture.workspaceRoot !== root)) {
    throw new Error('History capture expired or belongs to another workspace')
  }

  if (capture) {
    try {
      const existingHash = await git(root, [
        'log',
        HISTORY_BRANCH,
        '-1',
        '--format=%H',
        '--fixed-strings',
        '--grep',
        `SideKick-Capture-Id: ${capture.id}`
      ])
      if (existingHash) {
        const metadata = await commitMetadata(root, existingHash)
        const files = await changedPaths(root, metadata.baseTree, existingHash)
        await updateRef(root, APPLIED_REF, existingHash)
        await removeCapture(capture)
        return {
          hash: existingHash,
          changeCount: metadata.changeCount ?? files.length,
          captureVersion: metadata.captureVersion,
          changedPaths: files
        }
      }
    } catch {
      // The capture has not reached the active timeline yet.
    }
  }

  const afterTree = await writeWorkspaceTree(root)
  const parent = (await ref(root, APPLIED_REF)) ?? (await ref(root, HISTORY_BRANCH))
  const baseTree = capture?.baseTree ?? parent ?? EMPTY_TREE
  const files = await changedPaths(root, baseTree, afterTree)
  if (files.length === 0) {
    if (capture) await removeCapture(capture)
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  const body = `${message.trim() || 'SideKick changes'}\n\nSideKick-History-Version: ${HISTORY_VERSION}\nSideKick-Base-Tree: ${baseTree}\nSideKick-Changed-Files: ${files.length}${capture ? `\nSideKick-Capture-Id: ${capture.id}` : ''}`
  const env = {
    ...process.env,
    GIT_DIR: shadowDir(root),
    GIT_WORK_TREE: root,
    GIT_AUTHOR_DATE: `${now} +0000`,
    GIT_COMMITTER_DATE: `${now} +0000`
  }
  const args = ['commit-tree', afterTree, ...(parent ? ['-p', parent] : []), '-m', body]
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    env,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true
  })
  const hash = textOutput(stdout).trim()
  // The baseline tree is named only in commit metadata, which Git does not treat as
  // reachability. Keep an explicit ref so automatic object maintenance cannot make
  // an otherwise valid Undo point unrestorable.
  await updateRef(root, `refs/sidekick/bases/${hash}`, baseTree)
  await updateRef(root, HISTORY_BRANCH, hash)
  await updateRef(root, APPLIED_REF, hash)
  if (capture) await removeCapture(capture)
  return {
    hash,
    changeCount: files.length,
    captureVersion: HISTORY_VERSION,
    changedPaths: files
  }
}

export async function recoverInterruptedCheckpointCaptures(): Promise<
  RecoveredCheckpointCapture[]
> {
  const recovered: RecoveredCheckpointCapture[] = []
  let entries: string[] = []
  try {
    entries = await fs.readdir(join(configuredStorageRoot(), 'captures'))
  } catch {
    return recovered
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const capture = await loadPersistedCapture(entry.slice(0, -5))
    if (!capture) continue
    try {
      const checkpoint = await createCheckpoint(
        capture.workspaceRoot,
        'Interrupted agent changes',
        capture.id
      )
      if (checkpoint)
        recovered.push({
          conversationId: capture.conversationId,
          agentMessageId: capture.agentMessageId,
          workspaceRoot: capture.workspaceRoot,
          checkpoint
        })
    } catch (error) {
      console.warn('[History] Could not recover interrupted capture:', error)
    }
  }
  return recovered
}

async function treeState(
  workspaceRoot: string,
  tree: string,
  path: string
): Promise<TreeState | null> {
  const output = await git(workspaceRoot, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    tree,
    '--',
    path
  ])
  if (!output) return null
  const match = output.match(/^(\d+)\s+blob\s+([0-9a-f]{40,64})\t/)
  return match ? { mode: match[1], oid: match[2] } : null
}

function gitBlobHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  return createHash('sha1').update(header).update(content).digest('hex')
}

async function currentState(
  workspaceRoot: string,
  path: string
): Promise<TreeState | null | 'other'> {
  const absolute = join(workspaceRoot, path)
  try {
    const stat = await fs.lstat(absolute)
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(await fs.readlink(absolute), 'utf8')
      return { mode: '120000', oid: gitBlobHash(target) }
    }
    if (!stat.isFile()) return 'other'
    const content = await fs.readFile(absolute)
    return { mode: stat.mode & 0o111 ? '100755' : '100644', oid: gitBlobHash(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameState(left: TreeState | null | 'other', right: TreeState | null): boolean {
  if (left === 'other') return false
  if (left === null || right === null) return left === right
  return left.oid === right.oid && left.mode === right.mode
}

async function isAncestor(
  workspaceRoot: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await git(workspaceRoot, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

async function stagedPaths(workspaceRoot: string): Promise<Set<string>> {
  try {
    if ((await realGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
      return new Set()
    }
    const output = await realGit(workspaceRoot, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--relative',
      '--',
      '.'
    ])
    return new Set(output.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}

async function operationsForCommits(
  workspaceRoot: string,
  commits: string[],
  direction: 'backward' | 'forward'
): Promise<RestoreOperation[]> {
  const operations: RestoreOperation[] = []
  for (const hash of commits) {
    const metadata = await commitMetadata(workspaceRoot, hash)
    const afterTree = await git(workspaceRoot, ['rev-parse', `${hash}^{tree}`])
    const paths = await changedPaths(workspaceRoot, metadata.baseTree, afterTree)
    for (const path of paths) {
      const base = await treeState(workspaceRoot, metadata.baseTree, path)
      const after = await treeState(workspaceRoot, afterTree, path)
      operations.push({
        path,
        expectedTree: direction === 'backward' ? afterTree : metadata.baseTree,
        desiredTree: direction === 'backward' ? metadata.baseTree : afterTree,
        expected: direction === 'backward' ? after : base,
        desired: direction === 'backward' ? base : after
      })
    }
  }
  return operations
}

async function preflightOperations(
  workspaceRoot: string,
  operations: RestoreOperation[]
): Promise<HistoryConflict[]> {
  const staged = await stagedPaths(workspaceRoot)
  const virtual = new Map<string, TreeState | null | 'other'>()
  const conflicts = new Map<string, HistoryConflict>()

  for (const operation of operations) {
    if (conflicts.has(operation.path)) continue
    if (staged.has(operation.path)) {
      conflicts.set(operation.path, { path: operation.path, reason: 'staged-in-git' })
      continue
    }
    const current = virtual.has(operation.path)
      ? virtual.get(operation.path)!
      : await currentState(workspaceRoot, operation.path)
    if (current === 'other') {
      conflicts.set(operation.path, { path: operation.path, reason: 'unsupported-file' })
      continue
    }
    if (!sameState(current, operation.expected)) {
      conflicts.set(operation.path, { path: operation.path, reason: 'changed-after' })
      continue
    }
    virtual.set(operation.path, operation.desired)
  }
  return [...conflicts.values()]
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path)
  const rel = relative(workspaceRoot, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`History path escapes the workspace: ${path}`)
  }
  return absolute
}

async function applyTreeState(
  workspaceRoot: string,
  operation: RestoreOperation,
  state: TreeState | null,
  tree: string
): Promise<void> {
  const absolute = safeWorkspacePath(workspaceRoot, operation.path)
  if (!state) {
    await fs.rm(absolute, { force: true })
    return
  }
  await fs.mkdir(dirname(absolute), { recursive: true })
  await git(workspaceRoot, ['--literal-pathspecs', 'checkout', tree, '--', operation.path])
}

async function applyOperations(
  workspaceRoot: string,
  operations: RestoreOperation[]
): Promise<void> {
  const applied: RestoreOperation[] = []
  try {
    for (const operation of operations) {
      await applyTreeState(workspaceRoot, operation, operation.desired, operation.desiredTree)
      applied.push(operation)
    }
  } catch (error) {
    let rollbackError: unknown
    for (const operation of applied.reverse()) {
      try {
        await applyTreeState(workspaceRoot, operation, operation.expected, operation.expectedTree)
      } catch (candidate) {
        rollbackError ??= candidate
      }
    }
    if (rollbackError) {
      throw new Error(
        `History restore failed and could not fully roll back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: rollbackError }
      )
    }
    throw error
  }
}

function invertOperations(operations: RestoreOperation[]): RestoreOperation[] {
  return [...operations].reverse().map((operation) => ({
    path: operation.path,
    expectedTree: operation.desiredTree,
    desiredTree: operation.expectedTree,
    expected: operation.desired,
    desired: operation.expected
  }))
}

async function planRewindToBeforeCheckpoint(
  workspaceRoot: string,
  checkpointHash: string
): Promise<CoordinatedRewindPlan> {
  const root = resolve(workspaceRoot)
  await initShadowRepo(root)
  const previousBranch = await ref(root, HISTORY_BRANCH)
  const previousApplied = await ref(root, APPLIED_REF)
  if (
    !previousBranch ||
    !previousApplied ||
    !(await isAncestor(root, checkpointHash, previousApplied))
  ) {
    throw new Error('History point not found on the active timeline')
  }
  const history = (await git(root, ['rev-list', previousApplied])).split('\n').filter(Boolean)
  const checkpointIndex = history.indexOf(checkpointHash)
  if (checkpointIndex < 0) throw new Error('History point not found')
  return {
    workspaceRoot: root,
    checkpointHash,
    previousBranch,
    previousApplied,
    parentHash: await ref(root, `${checkpointHash}^`),
    operations: await operationsForCommits(root, history.slice(0, checkpointIndex + 1), 'backward')
  }
}

/**
 * Rewinds several independent project histories as one logical operation.
 * Every workspace is conflict-checked before any file changes are made. If an
 * application or ref update fails, already-applied workspaces are restored to
 * their exact prior file and ref state.
 */
export async function rewindWorkspacesToBeforeCheckpoints(
  targets: CoordinatedRewindTarget[]
): Promise<CoordinatedRewindResult> {
  const unique = new Map<string, CoordinatedRewindTarget>()
  for (const target of targets) {
    const root = resolve(target.workspaceRoot)
    const existing = unique.get(root)
    if (existing && existing.checkpointHash !== target.checkpointHash) {
      throw new Error('A workspace cannot be rewound to two history points at once')
    }
    unique.set(root, { ...target, workspaceRoot: root })
  }
  if (!unique.size) return { ok: true, workspaces: [] }

  const plans = await Promise.all(
    [...unique.values()].map(({ workspaceRoot, checkpointHash }) =>
      planRewindToBeforeCheckpoint(workspaceRoot, checkpointHash)
    )
  )
  const conflicts = (
    await Promise.all(
      plans.map(async (plan) =>
        (await preflightOperations(plan.workspaceRoot, plan.operations)).map((conflict) => ({
          ...conflict,
          workspaceRoot: plan.workspaceRoot
        }))
      )
    )
  ).flat()
  if (conflicts.length) return { ok: false, conflicts }

  const appliedPlans: CoordinatedRewindPlan[] = []
  const refsChanged: CoordinatedRewindPlan[] = []
  try {
    for (const plan of plans) {
      await applyOperations(plan.workspaceRoot, plan.operations)
      appliedPlans.push(plan)
    }
    for (const plan of plans) {
      refsChanged.push(plan)
      await updateRef(plan.workspaceRoot, HISTORY_BRANCH, plan.parentHash)
      await updateRef(plan.workspaceRoot, APPLIED_REF, plan.parentHash)
    }
  } catch (error) {
    let rollbackError: unknown
    for (const plan of [...refsChanged].reverse()) {
      try {
        await updateRef(plan.workspaceRoot, HISTORY_BRANCH, plan.previousBranch)
        await updateRef(plan.workspaceRoot, APPLIED_REF, plan.previousApplied)
      } catch (candidate) {
        rollbackError ??= candidate
      }
    }
    for (const plan of [...appliedPlans].reverse()) {
      try {
        await applyOperations(plan.workspaceRoot, invertOperations(plan.operations))
      } catch (candidate) {
        rollbackError ??= candidate
      }
    }
    if (rollbackError) {
      throw new Error(
        `Coordinated history rewind failed and could not fully roll back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: rollbackError }
      )
    }
    throw error
  }

  return {
    ok: true,
    workspaces: plans.map((plan) => ({
      workspaceRoot: plan.workspaceRoot,
      checkpointHash: plan.checkpointHash,
      parentHash: plan.parentHash,
      changedFiles: new Set(plan.operations.map(({ path }) => path)).size
    }))
  }
}

async function commitsBetween(
  workspaceRoot: string,
  applied: string,
  target: string
): Promise<{ commits: string[]; direction: 'backward' | 'forward' }> {
  if (applied === target) return { commits: [], direction: 'backward' }
  if (await isAncestor(workspaceRoot, target, applied)) {
    const output = await git(workspaceRoot, ['rev-list', applied, `^${target}`])
    return { commits: output.split('\n').filter(Boolean), direction: 'backward' }
  }
  if (await isAncestor(workspaceRoot, applied, target)) {
    const output = await git(workspaceRoot, ['rev-list', '--reverse', target, `^${applied}`])
    return { commits: output.split('\n').filter(Boolean), direction: 'forward' }
  }
  throw new Error('This history point is no longer on the active timeline')
}

async function moveAppliedState(
  workspaceRoot: string,
  target: string
): Promise<HistoryMutationResult> {
  await initShadowRepo(workspaceRoot)
  const tip = await ref(workspaceRoot, HISTORY_BRANCH)
  if (!tip || !(await isAncestor(workspaceRoot, target, tip))) {
    throw new Error('History point not found')
  }
  const applied = (await ref(workspaceRoot, APPLIED_REF)) ?? tip
  const sequence = await commitsBetween(workspaceRoot, applied, target)
  const operations = await operationsForCommits(workspaceRoot, sequence.commits, sequence.direction)
  const conflicts = await preflightOperations(workspaceRoot, operations)
  if (conflicts.length > 0) return { ok: false, conflicts }
  await applyOperations(workspaceRoot, operations)
  await updateRef(workspaceRoot, APPLIED_REF, target)
  return { ok: true, changedFiles: new Set(operations.map(({ path }) => path)).size }
}

export async function restoreCheckpoint(
  workspaceRoot: string,
  hash: string
): Promise<HistoryMutationResult> {
  return moveAppliedState(resolve(workspaceRoot), hash)
}

export async function hardResetCheckpoint(
  workspaceRoot: string,
  hash: string
): Promise<HistoryMutationResult> {
  const root = resolve(workspaceRoot)
  const result = await moveAppliedState(root, hash)
  if (!result.ok) return result
  await updateRef(root, HISTORY_BRANCH, hash)
  await updateRef(root, APPLIED_REF, hash)
  return result
}

export async function rewindToBeforeCheckpoint(
  workspaceRoot: string,
  hash: string
): Promise<HistoryMutationResult & { parentHash: string | null }> {
  const root = resolve(workspaceRoot)
  await initShadowRepo(root)
  const tip = await ref(root, HISTORY_BRANCH)
  const applied = await ref(root, APPLIED_REF)
  if (!tip || !applied || !(await isAncestor(root, hash, applied))) {
    throw new Error('History point not found on the active timeline')
  }
  const history = (await git(root, ['rev-list', applied])).split('\n').filter(Boolean)
  const checkpointIndex = history.indexOf(hash)
  if (checkpointIndex < 0) throw new Error('History point not found')
  const commits = history.slice(0, checkpointIndex + 1)
  const operations = await operationsForCommits(root, commits, 'backward')
  const conflicts = await preflightOperations(root, operations)
  const parentHash = await ref(root, `${hash}^`)
  if (conflicts.length > 0) return { ok: false, conflicts, parentHash }
  await applyOperations(root, operations)
  await updateRef(root, HISTORY_BRANCH, parentHash)
  await updateRef(root, APPLIED_REF, parentHash)
  return {
    ok: true,
    changedFiles: new Set(operations.map(({ path }) => path)).size,
    parentHash
  }
}

export async function getCheckpointDiff(workspaceRoot: string, hash: string): Promise<string> {
  const MAX_DIFF_BYTES = 8_000
  await initShadowRepo(workspaceRoot)
  const metadata = await commitMetadata(workspaceRoot, hash)
  const stat = await git(workspaceRoot, ['diff', '--stat', metadata.baseTree, hash])
  let patch = ''
  try {
    patch = await git(workspaceRoot, ['diff', '-U2', metadata.baseTree, hash])
    if (patch.length > MAX_DIFF_BYTES)
      patch = `${patch.slice(0, MAX_DIFF_BYTES)}\n... (diff truncated)`
  } catch {
    // Binary-only history entries still expose the stat summary.
  }
  return stat + (patch ? `\n\n${patch}` : '')
}

export async function getHistoryStatus(workspaceRoot: string): Promise<HistoryStatus> {
  await initShadowRepo(workspaceRoot)
  let realRepository = false
  try {
    realRepository =
      (await realGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    // Ordinary folders are fully supported by the private history repository.
  }
  return {
    storage: 'private-app-data',
    realRepository,
    appliedHash: await ref(workspaceRoot, APPLIED_REF)
  }
}

export async function listCheckpoints(workspaceRoot: string): Promise<Checkpoint[]> {
  await initShadowRepo(workspaceRoot)
  if (!(await ref(workspaceRoot, HISTORY_BRANCH))) return []
  const log = await git(workspaceRoot, ['log', HISTORY_BRANCH, '--format=%H%x1f%ct%x1f%B%x1e'])
  if (!log) return []

  const entries: Checkpoint[] = []
  for (const record of log
    .split('\x1e')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [hash, timestampText, ...bodyParts] = record.split('\x1f')
    const body = bodyParts.join('\x1f').trim()
    const metadata = await commitMetadata(workspaceRoot, hash)
    let changeCount = metadata.changeCount
    if (changeCount === undefined) {
      changeCount = (await changedPaths(workspaceRoot, metadata.baseTree, hash)).length
    }
    entries.push({
      hash,
      message: body.split(/\r?\n/)[0] || 'SideKick changes',
      timestamp: Number.parseInt(timestampText, 10) * 1000,
      workspaceRoot,
      changeCount,
      captureVersion: metadata.captureVersion
    })
  }
  return entries
}

export async function deleteShadowRepo(workspaceRoot: string): Promise<void> {
  await fs.rm(join(configuredStorageRoot(), workspaceKey(workspaceRoot)), {
    recursive: true,
    force: true
  })
  // Remove only the obsolete checkpoint engine. Never delete .sidekick itself:
  // it may contain user-owned SIDEKICK rules and other project content.
  await fs.rm(legacyShadowDir(workspaceRoot), { recursive: true, force: true })
}

export async function cleanupOldCheckpoints(workspaceRoot: string, maxAgeDays = 90): Promise<void> {
  try {
    const dir = shadowDir(workspaceRoot)
    await fs.access(dir)
    const latestTs = await git(workspaceRoot, ['log', HISTORY_BRANCH, '-1', '--format=%ct'])
    if (!latestTs) return
    const ageMs = Date.now() - Number.parseInt(latestTs, 10) * 1000
    if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
      await deleteShadowRepo(workspaceRoot)
      console.log(
        `[History] Removed private history older than ${maxAgeDays} days:`,
        basename(workspaceRoot)
      )
    }
  } catch {
    // No history or an unreadable legacy store needs no cleanup action here.
  }
}
