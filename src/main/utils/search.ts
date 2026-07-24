/**
 * Regex search across workspace files — no ripgrep dependency.
 * Walks directories recursively, filters by optional glob pattern,
 * searches each file with a JS regex, and returns results formatted
 * with 1 line of context above/below each match (Cline-style output).
 */

import { promises as fs } from 'fs'
import { join, relative } from 'path'

const MAX_RESULTS = 300
const MAX_FILE_SIZE = 512 * 1024 // skip files > 512 KB
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'out',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  'env',
  '.cache',
  'tmp',
  'temp'
])

/** Minimal glob → RegExp conversion: *.ts, **\/*.ts, *.{ts,tsx} */
function globToRegex(pattern: string): RegExp {
  const p = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*/g, '[^/]*')
    .replace(/\{([^}]+)\}/g, (_, alts) => `(${alts.split(',').join('|')})`)
  return new RegExp(`(^|/)${p}$`, 'i')
}

async function walkFiles(dir: string, filePattern: RegExp, results: string[]): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = (await fs.readdir(dir, {
      withFileTypes: true,
      encoding: 'utf-8'
    })) as import('fs').Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkFiles(fullPath, filePattern, results)
    } else if (filePattern.test(entry.name)) {
      results.push(fullPath)
    }
  }
}

export interface SearchFilesResult {
  output: string
  matchCount: number
  matchedFiles: string[]
}

export async function searchFiles(
  workspaceRoot: string,
  searchPath: string,
  regexPattern: string,
  filePattern?: string,
  contextLines: number = 1
): Promise<SearchFilesResult> {
  // Build file glob regex
  const globRegex = filePattern ? globToRegex(filePattern) : /./

  // Build search regex — treat as JS regex (close enough to Rust regex for most cases)
  let searchRegex: RegExp
  try {
    searchRegex = new RegExp(regexPattern, 'g')
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`)
  }

  // Collect matching files
  const allFiles: string[] = []
  await walkFiles(searchPath, globRegex, allFiles)

  // Search each file
  interface MatchEntry {
    filePath: string
    relPath: string
    lineNum: number
    contextBefore: string[]
    match: string
    contextAfter: string[]
  }

  const matches: MatchEntry[] = []

  outer: for (const filePath of allFiles) {
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(filePath)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_SIZE) continue

    let content: string
    try {
      content = await fs.readFile(filePath, 'utf-8')
    } catch {
      continue // skip binary files
    }

    const lines = content.split('\n')
    searchRegex.lastIndex = 0

    for (let i = 0; i < lines.length; i++) {
      searchRegex.lastIndex = 0
      if (searchRegex.test(lines[i])) {
        const ctx = Math.min(Math.max(0, contextLines), 5)
        const before = lines.slice(Math.max(0, i - ctx), i)
        const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctx))
        matches.push({
          filePath,
          relPath: relative(workspaceRoot, filePath).replace(/\\/g, '/'),
          lineNum: i + 1,
          contextBefore: before,
          match: lines[i],
          contextAfter: after
        })
        if (matches.length >= MAX_RESULTS) break outer
      }
    }
  }

  // Format output (Cline-style)
  const grouped = new Map<string, MatchEntry[]>()
  for (const m of matches) {
    if (!grouped.has(m.relPath)) grouped.set(m.relPath, [])
    grouped.get(m.relPath)!.push(m)
  }

  let output = ''
  if (matches.length >= MAX_RESULTS) {
    output += `Showing first ${MAX_RESULTS} of ${MAX_RESULTS}+ results. Use a more specific search if necessary.\n\n`
  } else {
    output += `Found ${matches.length === 1 ? '1 result' : `${matches.length} results`}.\n\n`
  }

  for (const [relPath, fileMatches] of grouped) {
    output += `${relPath}\n│----\n`
    for (let i = 0; i < fileMatches.length; i++) {
      const m = fileMatches[i]
      for (const line of m.contextBefore) output += `│${line.trimEnd()}\n`
      output += `│${m.match.trimEnd()}\n`
      for (const line of m.contextAfter) output += `│${line.trimEnd()}\n`
      if (i < fileMatches.length - 1) output += `│----\n`
    }
    output += `│----\n\n`
  }

  return {
    output: output.trimEnd(),
    matchCount: matches.length,
    matchedFiles: [...grouped.keys()]
  }
}
