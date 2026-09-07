export interface CanonicalPatchChunk {
  marker?: string
  endOfFile?: boolean
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
  // Strip only one complete Markdown wrapper, never prose or missing markers.
  if (/^```(?:diff|patch)?$/.test(lines[0] ?? '') && lines.at(-1) === '```') {
    lines.shift()
    lines.pop()
  }
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
      if (marker && /^-\d+(?:,\d+)?\s+\+\d+/.test(marker)) {
        throw new Error(
          'Invalid patch: unified-diff line numbers are unsupported; use a bare @@ header'
        )
      }
      index++
      const hunkLines: string[] = []
      let endOfFile = false
      while (
        index < lines.length - 1 &&
        !FILE_HEADER.test(lines[index]) &&
        !lines[index].startsWith('@@')
      ) {
        if (lines[index] === '*** End of File') {
          endOfFile = true
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
      chunks.push({ marker, lines: hunkLines, endOfFile })
      if (endOfFile && index < lines.length - 1 && !FILE_HEADER.test(lines[index])) {
        throw new Error(`Invalid patch for ${path}: End of File must terminate the file section`)
      }
    }
    if (!chunks.length) throw new Error(`Invalid Update File section for ${path}: no hunks found`)
    operations.push({ type: 'update', path, movePath, chunks })
  }

  if (!operations.length) throw new Error('Patch rejected: no file operations found')
  const consolidated: CanonicalPatchOperation[] = []
  for (const operation of operations) {
    const previous = consolidated.at(-1)
    if (
      previous?.type === 'update' &&
      operation.type === 'update' &&
      previous.path === operation.path &&
      !previous.movePath &&
      !operation.movePath &&
      !previous.chunks.some((chunk) => chunk.endOfFile)
    ) {
      previous.chunks.push(...operation.chunks)
    } else consolidated.push(operation)
  }
  const touched = new Set<string>()
  for (const operation of consolidated) {
    for (const path of [
      operation.path,
      operation.type === 'update' ? operation.movePath : undefined
    ]) {
      if (!path) continue
      if (touched.has(path)) {
        throw new Error(
          `Patch rejected: path is modified more than once: ${path}. Use one Update File section with ordered hunks. For a full rewrite, read the current file and replace its exact contents in one update hunk. Do not delete and add the same path in one patch.`
        )
      }
      touched.add(path)
    }
  }
  return consolidated
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
    throw new Error(
      `Patch could not be applied to ${path}: hunk context is stale or missing. ${PATCH_WHITESPACE_HELP}`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Patch could not be applied to ${path}: hunk context is ambiguous (${matches.length} matches)`
    )
  }
  return matches[0]
}

const PATCH_WHITESPACE_HELP =
  'Compare the exact source text and indentation. Each hunk prefix consumes exactly ONE character: -export removes "export", whereas - export removes " export" with a leading space. Do not add a separator space after + or -. SideKick preserves existing CRLF/LF endings automatically; use normal newline-separated patch lines.'

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

    // Offer a concrete correction for the observed model typo, but never apply
    // it automatically or relax exact matching. The caller must resubmit.
    let spacingHint = ''
    if (
      oldLines.length === 1 &&
      newLines.length === 1 &&
      oldLines[0].startsWith(' ') &&
      newLines[0].startsWith(' ') &&
      oldLines[0].length < 500 &&
      newLines[0].length < 500
    ) {
      const candidate = oldLines[0].slice(1)
      const positions = lines.flatMap((line, index) =>
        index >= searchStart && line === candidate ? [index] : []
      )
      if (positions.length === 1 && (!chunk.endOfFile || positions[0] === lines.length - 1)) {
        spacingHint = ` Possible separator-space typo: the unique source line is ${JSON.stringify(candidate)}. If the extra spaces were unintended, replace ONLY the two changed hunk lines with:\n-${candidate}\n+${newLines[0].slice(1)}\nKeep the full patch envelope and all other requested operations. Review this suggestion; no changes were made.`
      }
    }

    let matchIndex: number
    if (chunk.endOfFile) {
      matchIndex = lines.length - oldLines.length
      if (matchIndex < searchStart || !sequenceMatches(lines, oldLines, matchIndex)) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: End of File context does not match the file end. ${PATCH_WHITESPACE_HELP}${spacingHint}`
        )
      }
    } else if (!oldLines.length) {
      if (lines.length && !chunk.marker) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: insertion-only hunks require an @@ marker`
        )
      }
      matchIndex = chunk.marker ? searchStart + 1 : 0
    } else {
      try {
        matchIndex = findUniqueSequence(lines, oldLines, searchStart, operation.path)
      } catch (error) {
        if (spacingHint && error instanceof Error) throw new Error(error.message + spacingHint)
        throw error
      }
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
