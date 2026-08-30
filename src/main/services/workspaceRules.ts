import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  WorkspaceInstructionResolution,
  WorkspaceInstructionSource,
  WorkspaceRulesResult
} from '../../shared/workspaceInstructions'

const AGENT_RULE_NAMES = ['AGENTS.override.md', 'AGENTS.md'] as const
const PROJECT_RULE_PATHS = ['SIDEKICK.md', join('.sidekick', 'rules.md')]
const MAX_RULE_FILE_CHARS = 32_000
const MAX_COMBINED_CHARS = 64_000
const GLOBAL_RULE_CANDIDATES = [
  join('.sidekick', 'AGENTS.override.md'),
  join('.sidekick', 'AGENTS.md'),
  join('.agents', 'AGENTS.md')
] as const

interface InstructionCandidate {
  path: string
  displayPath: string
  kind: WorkspaceInstructionSource['kind']
  scope: string
}

interface CachedInstructionFile {
  mtimeMs: number
  size: number
  content: string
}

const instructionFileCache = new Map<string, CachedInstructionFile>()

async function readInstructionFile(path: string): Promise<{ content: string; isFile: boolean }> {
  const stat = await fs.stat(path)
  if (!stat.isFile()) return { content: '', isFile: false }
  const absolutePath = resolve(path)
  const cached = instructionFileCache.get(absolutePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { content: cached.content, isFile: true }
  }
  const content = await fs.readFile(absolutePath, 'utf8')
  instructionFileCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, content })
  return { content, isFile: true }
}

function instructionDirectories(projectRoot: string, workingDirectory: string): string[] {
  const normalizedRoot = resolve(projectRoot)
  const normalizedWorkingDirectory = resolve(workingDirectory)
  const pathFromRoot = relative(normalizedRoot, normalizedWorkingDirectory)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Working directory must be inside the project folder')
  }

  const directories: string[] = []
  let current = normalizedWorkingDirectory
  while (true) {
    directories.unshift(current)
    if (current === normalizedRoot) break
    current = dirname(current)
  }
  return directories
}

async function firstExistingFile(
  directory: string,
  names: readonly string[]
): Promise<string | null> {
  for (const name of names) {
    const path = join(directory, name)
    try {
      if ((await fs.stat(path)).isFile()) return path
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }
  return null
}

export async function loadWorkspaceRules(
  projectRoot: string,
  workingDirectory = projectRoot,
  options: { includeGlobal?: boolean; homeDirectory?: string } = {}
): Promise<WorkspaceRulesResult> {
  const normalizedRoot = resolve(projectRoot)
  const candidates: InstructionCandidate[] = []

  if (options.includeGlobal !== false) {
    const home = options.homeDirectory || homedir()
    const globalPath = await firstExistingFile(home, GLOBAL_RULE_CANDIDATES)
    if (globalPath) {
      candidates.push({
        path: globalPath,
        displayPath: `~/${relative(home, globalPath).replace(/\\/g, '/')}`,
        kind: 'global',
        scope: '*'
      })
    }
  }

  for (const customPath of PROJECT_RULE_PATHS) {
    candidates.push({
      path: join(normalizedRoot, customPath),
      displayPath: customPath.replace(/\\/g, '/'),
      kind: 'project',
      scope: '.'
    })
  }

  for (const directory of instructionDirectories(normalizedRoot, workingDirectory)) {
    const ruleFile = await firstExistingFile(directory, AGENT_RULE_NAMES)
    if (ruleFile) {
      const displayPath = relative(normalizedRoot, ruleFile).replace(/\\/g, '/')
      candidates.push({
        path: ruleFile,
        displayPath,
        kind: 'project',
        scope: relative(normalizedRoot, directory).replace(/\\/g, '/') || '.'
      })
    }
  }
  const sections: string[] = []
  const sources: string[] = []
  const sourceDetails: WorkspaceInstructionSource[] = []
  let totalChars = 0
  let truncated = false

  for (const candidate of candidates) {
    try {
      const loaded = await readInstructionFile(candidate.path)
      if (!loaded.isFile) continue

      let content = loaded.content
      let sourceTruncated = false
      if (content.length > MAX_RULE_FILE_CHARS) {
        content = `${content.slice(0, MAX_RULE_FILE_CHARS)}\n\n[Rule file truncated]`
        truncated = true
        sourceTruncated = true
      }

      const remaining = MAX_COMBINED_CHARS - totalChars
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (content.length > remaining) {
        content = `${content.slice(0, Math.max(0, remaining - 24))}\n\n[Rules truncated]`
        truncated = true
        sourceTruncated = true
      }

      sections.push(`## ${candidate.displayPath}\n\n${content.trim()}`)
      sources.push(candidate.displayPath)
      sourceDetails.push({
        path: resolve(candidate.path),
        displayPath: candidate.displayPath,
        kind: candidate.kind,
        scope: candidate.scope,
        truncated: sourceTruncated
      })
      totalChars += content.length
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }

  return { content: sections.join('\n\n'), sources, sourceDetails, truncated }
}

interface InstructionScope {
  projectRoot: string
  basePaths: Set<string>
  claimedPaths: Set<string>
  touchedAt: number
}

const instructionScopes = new Map<string, InstructionScope>()
const MAX_INSTRUCTION_SCOPES = 200

function pruneInstructionScopes(): void {
  if (instructionScopes.size <= MAX_INSTRUCTION_SCOPES) return
  const oldest = [...instructionScopes.entries()]
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    .slice(0, instructionScopes.size - MAX_INSTRUCTION_SCOPES)
  for (const [scopeId] of oldest) instructionScopes.delete(scopeId)
}

function emptyResolution(): WorkspaceInstructionResolution {
  return {
    content: '',
    sources: [],
    sourceDetails: [],
    truncated: false,
    retryRequired: false
  }
}

async function renderInstructionSources(
  details: WorkspaceInstructionSource[]
): Promise<{ content: string; sourceDetails: WorkspaceInstructionSource[]; truncated: boolean }> {
  const sections: string[] = []
  const renderedDetails: WorkspaceInstructionSource[] = []
  let remaining = MAX_COMBINED_CHARS
  let truncated = false
  for (const detail of details) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const loaded = await readInstructionFile(detail.path)
    if (!loaded.isFile) continue
    let content = loaded.content
    let sourceTruncated = false
    if (content.length > MAX_RULE_FILE_CHARS) {
      content = `${content.slice(0, MAX_RULE_FILE_CHARS)}\n\n[Rule file truncated]`
      sourceTruncated = true
      truncated = true
    }
    if (content.length > remaining) {
      content = `${content.slice(0, Math.max(0, remaining - 24))}\n\n[Rules truncated]`
      sourceTruncated = true
      truncated = true
    }
    sections.push(`## ${detail.displayPath}\n\n${content.trim()}`)
    renderedDetails.push({ ...detail, truncated: sourceTruncated })
    remaining -= content.length
  }
  return { content: sections.join('\n\n'), sourceDetails: renderedDetails, truncated }
}

/** Begin one provider run and mark its initial global/root instructions as delivered. */
export async function beginWorkspaceInstructionScope(
  scopeId: string,
  projectRoot: string
): Promise<WorkspaceRulesResult> {
  const normalizedRoot = resolve(projectRoot)
  const initial = await loadWorkspaceRules(normalizedRoot)
  const basePaths = new Set(initial.sourceDetails.map(({ path }) => path))
  instructionScopes.set(scopeId, {
    projectRoot: normalizedRoot,
    basePaths,
    claimedPaths: new Set(basePaths),
    touchedAt: Date.now()
  })
  pruneInstructionScopes()
  return initial
}

function targetDirectory(projectRoot: string, targetPath: string, isDirectory: boolean): string {
  const absolute = resolve(projectRoot, targetPath || '.')
  const pathFromRoot = relative(projectRoot, absolute)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Instruction target must be inside the project folder')
  }
  return isDirectory ? absolute : dirname(absolute)
}

/** Resolve newly applicable instructions for one file/directory access. */
export async function resolveWorkspaceInstructionsForPath(
  scopeId: string,
  projectRoot: string,
  targetPath: string,
  isDirectory = false,
  mutation = false
): Promise<WorkspaceInstructionResolution> {
  const normalizedRoot = resolve(projectRoot)
  let scope = instructionScopes.get(scopeId)
  if (!scope || scope.projectRoot !== normalizedRoot) {
    await beginWorkspaceInstructionScope(scopeId, normalizedRoot)
    scope = instructionScopes.get(scopeId)!
  }

  const loaded = await loadWorkspaceRules(
    normalizedRoot,
    targetDirectory(normalizedRoot, targetPath, isDirectory)
  )
  const newDetails = loaded.sourceDetails.filter(({ path }) => !scope!.claimedPaths.has(path))
  if (!newDetails.length) {
    scope.touchedAt = Date.now()
    return emptyResolution()
  }

  const rendered = await renderInstructionSources(newDetails)
  for (const { path } of rendered.sourceDetails) scope.claimedPaths.add(path)
  scope.touchedAt = Date.now()
  return {
    content: rendered.content,
    sources: rendered.sourceDetails.map(({ displayPath }) => displayPath),
    sourceDetails: rendered.sourceDetails,
    truncated: rendered.truncated,
    retryRequired: mutation
  }
}

/** After compaction, retain base instructions but allow scoped reminders to load again. */
export function resetWorkspaceInstructionScope(scopeId: string): void {
  const scope = instructionScopes.get(scopeId)
  if (!scope) return
  scope.claimedPaths = new Set(scope.basePaths)
  scope.touchedAt = Date.now()
}

export function clearWorkspaceInstructionScope(scopeId: string): void {
  instructionScopes.delete(scopeId)
}
