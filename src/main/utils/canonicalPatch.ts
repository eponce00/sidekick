export interface CanonicalPatchChunk {
  marker?: string
  lines: string[]
}

export type CanonicalPatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: CanonicalPatchChunk[] }

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/

function normalizedPatchLines(patch: string): string[] {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n')
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new Error('Invalid patch: expected *** Begin Patch and *** End Patch sentinels')
  }
  return lines
}

function requireRelativePath(value: string, label: string): string {
  const path = value.trim()
  if (!path) throw new Error(`Invalid patch: ${label} path is empty`)
  if (path.includes('\0')) throw new Error(`Invalid patch: ${label} path contains a null byte`)
  return path
}

/** Parse the canonical Codex patch envelope without touching the filesystem. */
export function parseCanonicalPatch(patch: string): CanonicalPatchOperation[] {
  const lines = normalizedPatchLines(patch)
  const operations: CanonicalPatchOperation[] = []
  let index = 1

  while (index < lines.length - 1) {
    const header = FILE_HEADER.exec(lines[index])
    if (!header)
      throw new Error(`Invalid patch line ${index + 1}: expected a file operation header`)
    const [, action, rawPath] = header
    const path = requireRelativePath(rawPath, action)
    index++

    if (action === 'Add') {
      const content: string[] = []
      while (index < lines.length - 1 && !FILE_HEADER.test(lines[index])) {
        if (!lines[index].startsWith('+')) {
          throw new Error(
            `Invalid Add File section for ${path}: every content line must begin with +`
          )
        }
        content.push(lines[index].slice(1))
        index++
      }
      operations.push({
        type: 'add',
        path,
        content: content.length ? `${content.join('\n')}\n` : ''
      })
      continue
    }

    if (action === 'Delete') {
      if (index < lines.length - 1 && !FILE_HEADER.test(lines[index])) {
        throw new Error(`Invalid Delete File section for ${path}: unexpected content`)
      }
      operations.push({ type: 'delete', path })
      continue
    }

    let movePath: string | undefined
    const move = MOVE_HEADER.exec(lines[index] ?? '')
    if (move) {
      movePath = requireRelativePath(move[1], 'Move')
      index++
    }

    const chunks: CanonicalPatchChunk[] = []
    while (index < lines.length - 1 && !FILE_HEADER.test(lines[index])) {
      if (!lines[index].startsWith('@@')) {
        throw new Error(`Invalid Update File section for ${path}: expected an @@ hunk header`)
      }
      const marker = lines[index].slice(2).trim() || undefined
      index++
      const hunkLines: string[] = []
      while (
        index < lines.length - 1 &&
        !FILE_HEADER.test(lines[index]) &&
        !lines[index].startsWith('@@')
      ) {
        if (lines[index] === '*** End of File') {
          index++
          break
        }
        if (![' ', '+', '-'].includes(lines[index][0] ?? '')) {
          throw new Error(
            `Invalid hunk for ${path} at line ${index + 1}: lines must begin with a space, +, or -`
          )
        }
        hunkLines.push(lines[index])
        index++
      }
      if (!hunkLines.some((line) => line.startsWith('+') || line.startsWith('-'))) {
        throw new Error(`Invalid hunk for ${path}: hunk contains no changes`)
      }
      chunks.push({ marker, lines: hunkLines })
    }
    if (!chunks.length) throw new Error(`Invalid Update File section for ${path}: no hunks found`)
    operations.push({ type: 'update', path, movePath, chunks })
  }

  if (!operations.length) throw new Error('Patch rejected: no file operations found')
  const touched = new Set<string>()
  for (const operation of operations) {
    for (const path of [
      operation.path,
      operation.type === 'update' ? operation.movePath : undefined
    ]) {
      if (!path) continue
      if (touched.has(path)) {
        throw new Error(`Patch rejected: path is modified more than once: ${path}`)
      }
      touched.add(path)
    }
  }
  return operations
}

interface FileLines {
  lines: string[]
  ending: '\n' | '\r\n'
  trailingNewline: boolean
}

function splitFile(content: string): FileLines {
  const ending = content.includes('\r\n') ? '\r\n' : '\n'
  const normalized = content.replace(/\r\n/g, '\n')
  const trailingNewline = normalized.endsWith('\n')
  const body = trailingNewline ? normalized.slice(0, -1) : normalized
  return { lines: body ? body.split('\n') : [], ending, trailingNewline }
}

function sequenceMatches(lines: string[], needle: string[], at: number): boolean {
  return needle.every((line, offset) => lines[at + offset] === line)
}

function findUniqueSequence(
  lines: string[],
  needle: string[],
  start: number,
  path: string
): number {
  const matches: number[] = []
  for (let index = start; index <= lines.length - needle.length; index++) {
    if (sequenceMatches(lines, needle, index)) matches.push(index)
  }
  if (!matches.length) {
    throw new Error(`Patch could not be applied to ${path}: hunk context is stale or missing`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Patch could not be applied to ${path}: hunk context is ambiguous (${matches.length} matches)`
    )
  }
  return matches[0]
}

/** Apply a verified Update File operation to one in-memory file. */
export function applyCanonicalUpdate(
  original: string,
  operation: Extract<CanonicalPatchOperation, { type: 'update' }>
): string {
  const file = splitFile(original)
  const lines = [...file.lines]
  let cursor = 0

  for (const chunk of operation.chunks) {
    let searchStart = cursor
    if (chunk.marker) {
      const markerMatches = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line, index }) => index >= cursor && line.includes(chunk.marker!))
        .map(({ index }) => index)
      if (!markerMatches.length) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: @@ marker not found: ${chunk.marker}`
        )
      }
      if (markerMatches.length > 1) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: @@ marker is ambiguous (${markerMatches.length} matches): ${chunk.marker}`
        )
      }
      searchStart = markerMatches[0]
    }

    const oldLines = chunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1))
    const newLines = chunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+'))
      .map((line) => line.slice(1))

    let matchIndex: number
    if (!oldLines.length) {
      if (lines.length && !chunk.marker) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: insertion-only hunks require an @@ marker`
        )
      }
      matchIndex = chunk.marker ? searchStart + 1 : 0
    } else {
      matchIndex = findUniqueSequence(lines, oldLines, searchStart, operation.path)
    }
    lines.splice(matchIndex, oldLines.length, ...newLines)
    cursor = matchIndex + newLines.length
  }

  const normalized = lines.join('\n') + (file.trailingNewline ? '\n' : '')
  const result = file.ending === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  if (result === original)
    throw new Error(`Patch rejected: update produced no changes for ${operation.path}`)
  return result
}
