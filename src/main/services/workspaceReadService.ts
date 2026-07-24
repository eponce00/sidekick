import { createReadStream, promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { createInterface } from 'readline'
import { workspaceFileVersion } from '../utils/workspaceFileVersion'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'

const DEFAULT_READ_LINES = 500
const MAX_READ_LINES = 2_000
const DEFAULT_READ_BYTES = 50 * 1024
const MAX_LIST_RESULTS = 2_000
const MAX_SEARCH_RESULTS = 300
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.sidekick-history',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage'
])

export interface WorkspaceReadResult {
  content: string
  totalLines: number
  startLine: number
  endLine: number
  nextLine: number | null
  truncated: boolean
  version: string
  size: number
}

export interface WorkspaceListResult {
  files: string[]
  truncated: boolean
  nextCursor: number | null
}

export interface WorkspaceSearchResult {
  output: string
  matchCount: number
  matchedFiles: string[]
  truncated: boolean
}

export class WorkspaceSearchArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceSearchArgumentError'
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Workspace operation cancelled', 'AbortError')
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\uE000')
    .replace(/\*/g, '[^/]*')
    .replace(/\uE000/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

function assertTextSample(sample: Buffer, path: string): void {
  if (sample.includes(0)) throw new Error(`Cannot read binary file as UTF-8: ${path}`)
}

export class WorkspaceReadService {
  async getFileVersion(workspaceRoot: string, filePath: string): Promise<string | null> {
    const fullPath = await resolveSecureWorkspacePath(workspaceRoot, filePath)
    try {
      const stat = await fs.stat(fullPath)
      return stat.isFile() ? workspaceFileVersion(stat) : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async readFile(
    workspaceRoot: string,
    filePath: string,
    options: {
      startLine?: number
      endLine?: number
      maxLines?: number
      maxBytes?: number
      signal?: AbortSignal
    } = {}
  ): Promise<WorkspaceReadResult> {
    abortIfNeeded(options.signal)
    const fullPath = await resolveSecureWorkspacePath(workspaceRoot, filePath)
    const stat = await fs.stat(fullPath)
    if (!stat.isFile()) throw new Error(`Path is not a regular file: ${filePath}`)
    const sampleHandle = await fs.open(fullPath, 'r')
    try {
      const sample = Buffer.alloc(Math.min(8_192, stat.size))
      const { bytesRead } = await sampleHandle.read(sample, 0, sample.length, 0)
      assertTextSample(sample.subarray(0, bytesRead), filePath)
    } finally {
      await sampleHandle.close()
    }

    const startLine = Math.max(1, Math.trunc(options.startLine ?? 1))
    const requestedEnd =
      options.endLine == null
        ? Number.POSITIVE_INFINITY
        : Math.max(startLine, Math.trunc(options.endLine))
    const maxLines = Math.max(
      1,
      Math.min(MAX_READ_LINES, Math.trunc(options.maxLines ?? DEFAULT_READ_LINES))
    )
    const maxBytes = Math.max(
      1_024,
      Math.min(256 * 1024, Math.trunc(options.maxBytes ?? DEFAULT_READ_BYTES))
    )
    const lastAllowedLine = Math.min(requestedEnd, startLine + maxLines - 1)
    const stream = createReadStream(fullPath, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    const selected: string[] = []
    let totalLines = 0
    let returnedBytes = 0
    let endedByByteLimit = false
    const onAbort = (): void => {
      stream.destroy(new DOMException('Workspace read cancelled', 'AbortError'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const line of reader) {
        abortIfNeeded(options.signal)
        totalLines++
        if (totalLines < startLine || totalLines > lastAllowedLine || endedByByteLimit) continue
        const numbered = `${totalLines}: ${line}`
        const bytes = Buffer.byteLength(numbered + '\n')
        if (returnedBytes + bytes > maxBytes) {
          endedByByteLimit = true
          continue
        }
        selected.push(numbered)
        returnedBytes += bytes
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      reader.close()
      stream.destroy()
    }

    const endLine = selected.length
      ? startLine + selected.length - 1
      : Math.min(totalLines, startLine - 1)
    const truncated = endedByByteLimit || endLine < Math.min(totalLines, requestedEnd)
    const completedStat = await fs.stat(fullPath)
    const initialVersion = workspaceFileVersion(stat)
    const completedVersion = workspaceFileVersion(completedStat)
    if (initialVersion !== completedVersion) {
      throw new Error(`File changed while it was being read: ${filePath}; retry the read`)
    }
    return {
      content: selected.join('\n'),
      totalLines,
      startLine,
      endLine,
      nextLine: truncated ? endLine + 1 : null,
      truncated,
      version: completedVersion,
      size: stat.size
    }
  }

  async listFiles(
    workspaceRoot: string,
    options: {
      subPath?: string
      glob?: string
      cursor?: number
      maxResults?: number
      signal?: AbortSignal
    } = {}
  ): Promise<WorkspaceListResult> {
    abortIfNeeded(options.signal)
    const targetDir = await resolveSecureWorkspacePath(workspaceRoot, options.subPath || '')
    const filter = options.glob ? globToRegex(options.glob) : null
    const cursor = Math.max(0, Math.trunc(options.cursor ?? 0))
    const maxResults = Math.max(
      1,
      Math.min(MAX_LIST_RESULTS, Math.trunc(options.maxResults ?? 1_000))
    )
    const collected: string[] = []
    const pending = [targetDir]
    while (pending.length) {
      abortIfNeeded(options.signal)
      const directory = pending.pop()!
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      const childDirectories: string[] = []
      for (const entry of entries) {
        abortIfNeeded(options.signal)
        if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
        const absolute = join(directory, entry.name)
        const path = normalizePath(relative(workspaceRoot, absolute))
        if (entry.isDirectory()) {
          if (!filter) collected.push(`${path}/`)
          childDirectories.push(absolute)
        } else if (!filter || filter.test(path)) {
          collected.push(path)
        }
      }
      for (let index = childDirectories.length - 1; index >= 0; index--)
        pending.push(childDirectories[index])
      if (collected.length > cursor + maxResults) break
    }
    const files = collected.slice(cursor, cursor + maxResults)
    const truncated = collected.length > cursor + files.length || pending.length > 0
    return { files, truncated, nextCursor: truncated ? cursor + files.length : null }
  }

  async searchFiles(
    workspaceRoot: string,
    options: {
      regex: string
      path?: string
      filePattern?: string
      contextLines?: number
      signal?: AbortSignal
    }
  ): Promise<WorkspaceSearchResult> {
    abortIfNeeded(options.signal)
    if (!options.regex || options.regex.length > 10_000) {
      throw new WorkspaceSearchArgumentError(
        'Search regular expression must contain between 1 and 10,000 characters'
      )
    }
    let expression: RegExp
    try {
      expression = new RegExp(options.regex, 'i')
    } catch (error) {
      throw new WorkspaceSearchArgumentError(
        `Invalid search regular expression: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const contextLines = Math.max(0, Math.min(5, Math.trunc(options.contextLines ?? 0)))
    let listed: WorkspaceListResult
    if (options.path) {
      const target = await resolveSecureWorkspacePath(workspaceRoot, options.path)
      let stat
      try {
        stat = await fs.stat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new WorkspaceSearchArgumentError(`Search path does not exist: ${options.path}`)
        }
        throw error
      }
      if (stat.isFile()) {
        const relativePath = normalizePath(relative(workspaceRoot, target))
        const matchesPattern = options.filePattern
          ? globToRegex(options.filePattern).test(relativePath)
          : true
        listed = {
          files: matchesPattern ? [relativePath] : [],
          truncated: false,
          nextCursor: null
        }
      } else if (stat.isDirectory()) {
        listed = await this.listFiles(workspaceRoot, {
          subPath: options.path,
          glob: options.filePattern,
          maxResults: MAX_LIST_RESULTS,
          signal: options.signal
        })
      } else {
        throw new WorkspaceSearchArgumentError(
          `Search path is neither a regular file nor a directory: ${options.path}`
        )
      }
    } else {
      listed = await this.listFiles(workspaceRoot, {
        glob: options.filePattern,
        maxResults: MAX_LIST_RESULTS,
        signal: options.signal
      })
    }
    const output: string[] = []
    const matchedFiles = new Set<string>()
    let matchCount = 0
    let truncated = listed.truncated
    for (const filePath of listed.files) {
      abortIfNeeded(options.signal)
      if (filePath.endsWith('/')) continue
      const absolute = await resolveSecureWorkspacePath(workspaceRoot, filePath)
      const stat = await fs.stat(absolute)
      if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue
      let raw: string
      try {
        const buffer = await fs.readFile(absolute)
        assertTextSample(buffer.subarray(0, Math.min(buffer.length, 8_192)), filePath)
        raw = buffer.toString('utf8')
      } catch (error) {
        if ((error as Error).message.startsWith('Cannot read binary')) continue
        throw error
      }
      const lines = raw.replace(/\r\n?/g, '\n').split('\n')
      for (let index = 0; index < lines.length; index++) {
        expression.lastIndex = 0
        if (!expression.test(lines[index])) continue
        matchedFiles.add(filePath)
        matchCount++
        const first = Math.max(0, index - contextLines)
        const last = Math.min(lines.length - 1, index + contextLines)
        output.push(`${filePath}:${index + 1}`)
        for (let line = first; line <= last; line++) output.push(`${line + 1}: ${lines[line]}`)
        if (matchCount >= MAX_SEARCH_RESULTS) {
          truncated = true
          break
        }
      }
      if (matchCount >= MAX_SEARCH_RESULTS) break
    }
    if (truncated) output.push(`… results truncated after ${matchCount} matches …`)
    return { output: output.join('\n'), matchCount, matchedFiles: [...matchedFiles], truncated }
  }
}
