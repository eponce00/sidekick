import {
  carryOriginalCharacters,
  closestRegion,
  normalizeLine,
  stripReadLineNumbers
} from './tolerantMatch'

export interface CanonicalPatchChunk {
  marker?: string
  endOfFile?: boolean
  lines: string[]
}

export type CanonicalPatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: CanonicalPatchChunk[] }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/
const UNIFIED_RANGE = /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s*@@)?\s*(.*)$/
const HEREDOC = /^(?:apply_patch\s*)?<<-?\s*['"]?([A-Za-z_]\w*)['"]?\s*$/

function trimBlankEdges(lines: string[]): void {
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.length && lines.at(-1)!.trim() === '') lines.pop()
}

/** Strip a git-style path prefix from a unified-diff header path. */
function unifiedPath(value: string): string {
  const path = value.split('\t')[0].trim()
  return /^[ab]\//.test(path) ? path.slice(2) : path
}

/**
 * Convert a plain unified diff (--- / +++ headers and @@ hunks) into the canonical envelope.
 * Models trained on git output often send this shape; its context is still matched exactly.
 */
function canonicalFromUnifiedDiff(lines: string[]): string[] | undefined {
  const out = [BEGIN]
  let index = 0
  let sawFile = false
  while (index < lines.length) {
    const line = lines[index]
    if (/^(?:diff --git |index |new file mode |deleted file mode |similarity index )/.test(line)) {
      index++
      continue
    }
    if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      const from = unifiedPath(line.slice(4))
      const to = unifiedPath(lines[index + 1].slice(4))
      index += 2
      sawFile = true
      const body: string[] = []
      while (
        index < lines.length &&
        !(lines[index].startsWith('--- ') && lines[index + 1]?.startsWith('+++ '))
      ) {
        if (
          !/^(?:diff --git |index )/.test(lines[index]) &&
          lines[index] !== '\\ No newline at end of file'
        ) {
          body.push(lines[index])
        }
        index++
      }
      if (to === '/dev/null') {
        out.push(`*** Delete File: ${from}`)
      } else if (from === '/dev/null') {
        out.push(`*** Add File: ${to}`)
        out.push(...body.filter((entry) => entry.startsWith('+')))
      } else {
        out.push(`*** Update File: ${from}`)
        if (to !== from) out.push(`*** Move to: ${to}`)
        out.push(...body)
      }
      continue
    }
    if (sawFile || line.trim()) return undefined
    index++
  }
  return sawFile ? [...out, END] : undefined
}

function normalizedPatchLines(patch: string): string[] {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n')
  trimBlankEdges(lines)
  // Strip only one complete Markdown or shell heredoc wrapper, never surrounding prose.
  if (/^```(?:diff|patch)?$/.test(lines[0] ?? '') && lines.at(-1) === '```') {
    lines.shift()
    lines.pop()
  }
  const heredoc = HEREDOC.exec(lines[0] ?? '')
  if (heredoc && lines.at(-1)?.trim() === heredoc[1]) {
    lines.shift()
    lines.pop()
  }
  trimBlankEdges(lines)
  if (lines[0] !== BEGIN && !lines.some((line) => FILE_HEADER.test(line))) {
    const converted = canonicalFromUnifiedDiff(lines)
    if (converted) return converted
  }
  // A body that starts with a file operation lost only its envelope; restore it. The JSON
  // argument itself is complete (truncated tool calls are rejected before parsing), so a
  // missing End sentinel is an omission, not a cut-off patch.
  if (lines[0] !== BEGIN && FILE_HEADER.test(lines[0] ?? '')) lines.unshift(BEGIN)
  if (lines[0] === BEGIN && lines.at(-1) !== END) {
    // Models close the patch with *** End of Patch, or with *** End of File when no End
    // sentinel follows; both mean the end of the patch, not an end-of-file anchor.
    const last = lines.at(-1)
    if (last === '*** End of Patch' || (last === '*** End of File' && !lines.includes(END))) {
      lines[lines.length - 1] = END
    } else lines.push(END)
  }
  if (lines[0] !== BEGIN || lines.at(-1) !== END) {
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
    const takeMove = (): boolean => {
      const move = MOVE_HEADER.exec(lines[index] ?? '')
      if (!move) return false
      if (movePath)
        throw new Error(`Invalid Update File section for ${path}: more than one Move to`)
      movePath = requireRelativePath(move[1], 'Move')
      index++
      return true
    }
    takeMove()

    const chunks: CanonicalPatchChunk[] = []
    while (index < lines.length - 1 && !FILE_HEADER.test(lines[index])) {
      // A rename header placed after a hunk still names this section's destination.
      if (takeMove()) continue
      if (!lines[index].startsWith('@@')) {
        throw new Error(`Invalid Update File section for ${path}: expected an @@ hunk header`)
      }
      let marker = lines[index].slice(2).trim() || undefined
      // Unified-diff line numbers are ignored; any section text after them is a location hint.
      const unified = marker ? UNIFIED_RANGE.exec(marker) : null
      if (unified) marker = unified[1].replace(/@@\s*$/, '').trim() || undefined
      if (marker === '@@') marker = undefined
      index++
      const hunkLines: string[] = []
      let trailingBlank = 0
      let endOfFile = false
      while (
        index < lines.length - 1 &&
        !FILE_HEADER.test(lines[index]) &&
        !lines[index].startsWith('@@') &&
        !MOVE_HEADER.test(lines[index])
      ) {
        if (lines[index] === '*** End of File') {
          endOfFile = true
          index++
          break
        }
        // An empty line is an empty context line whose leading space was dropped.
        const line = lines[index] === '' ? ' ' : lines[index]
        if (![' ', '+', '-'].includes(line[0])) {
          throw new Error(
            `Invalid hunk for ${path} at line ${index + 1}: lines must begin with a space, +, or -`
          )
        }
        trailingBlank = lines[index] === '' ? trailingBlank + 1 : 0
        hunkLines.push(line)
        index++
      }
      // Blank lines between a hunk and the next header are separators, not file context.
      if (!endOfFile) hunkLines.splice(hunkLines.length - trailingBlank, trailingBlank)
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
    // Several plain Update sections for one path are one ordered update; hunks that refer to
    // earlier text are located again from the top of the file.
    const previous =
      operation.type === 'update' && !operation.movePath
        ? consolidated.find(
            (candidate): candidate is Extract<CanonicalPatchOperation, { type: 'update' }> =>
              candidate.type === 'update' &&
              candidate.path === operation.path &&
              !candidate.movePath &&
              !candidate.chunks.some((chunk) => chunk.endOfFile)
          )
        : undefined
    if (previous && operation.type === 'update') previous.chunks.push(...operation.chunks)
    else consolidated.push(operation)
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
  /** Each line's own terminator, so mixed CRLF/LF files keep every unchanged line's ending. */
  endings: string[]
  dominant: '\n' | '\r\n'
  trailingNewline: boolean
}

function splitFile(content: string): FileLines {
  const lines: string[] = []
  const endings: string[] = []
  let crlf = 0
  let lf = 0
  let start = 0
  for (const match of content.matchAll(/\r\n|\n/g)) {
    lines.push(content.slice(start, match.index))
    endings.push(match[0])
    if (match[0] === '\r\n') crlf++
    else lf++
    start = match.index + match[0].length
  }
  const trailingNewline = start === content.length && content.length > 0
  if (start < content.length) {
    lines.push(content.slice(start))
    endings.push('')
  }
  return { lines, endings, dominant: crlf > lf ? '\r\n' : '\n', trailingNewline }
}

function sequenceMatches(
  lines: readonly string[],
  needle: readonly string[],
  at: number,
  same: (a: string, b: string) => boolean
): boolean {
  return needle.every((line, offset) => same(lines[at + offset], line))
}

const exactLine = (a: string, b: string) => a === b
const tolerantLine = (a: string | undefined, b: string) =>
  a !== undefined && normalizeLine(a) === normalizeLine(b)

function matchesFrom(
  lines: readonly string[],
  needle: readonly string[],
  start: number,
  same: (a: string, b: string) => boolean
): number[] {
  const matches: number[] = []
  for (let index = start; index <= lines.length - needle.length; index++) {
    if (sequenceMatches(lines, needle, index, same)) matches.push(index)
  }
  return matches
}

interface HunkLocation {
  index: number
  /** The file text differed from the hunk only by normalization; carry file characters. */
  tolerant: boolean
}

/**
 * Locate a hunk's old lines: exactly after the cursor, then exactly anywhere (hunks given out of
 * order), then the same two ways ignoring line endings, trailing whitespace, typography and
 * invisible marks. Every tier requires exactly one match.
 */
function locateHunk(
  lines: readonly string[],
  oldLines: readonly string[],
  cursor: number,
  path: string
): HunkLocation {
  for (const [same, tolerant] of [
    [exactLine, false],
    [tolerantLine, true]
  ] as const) {
    for (const start of cursor > 0 ? [cursor, 0] : [0]) {
      const matches = matchesFrom(lines, oldLines, start, same)
      if (matches.length === 1) return { index: matches[0], tolerant }
      if (matches.length > 1) {
        throw new Error(
          `Patch could not be applied to ${path}: hunk context is ambiguous (${matches.length} matches, starting at lines ${matches
            .slice(0, 8)
            .map((match) => match + 1)
            .join(', ')}). Add surrounding lines so the hunk matches one place.`
        )
      }
    }
  }
  const region = closestRegion(lines.join('\n'), oldLines.join('\n'))
  throw new Error(
    `Patch could not be applied to ${path}: hunk context is stale or missing. ${PATCH_WHITESPACE_HELP}` +
      (region
        ? `\nClosest current lines (line numbers are for reference only; do not include them in the patch):\n${region}`
        : ' Re-read the file and copy the current lines exactly.')
  )
}

const PATCH_WHITESPACE_HELP =
  'Compare the exact source text and indentation. Each hunk prefix consumes exactly ONE character: -export removes "export", whereas - export removes " export" with a leading space. Do not add a separator space after + or -. SideKick preserves existing CRLF/LF endings automatically; use normal newline-separated patch lines.'

/** Hunk lines with read-tool `N: ` prefixes removed when every line carries one. */
function withoutReadLineNumbers(chunkLines: string[]): string[] | undefined {
  const stripped = stripReadLineNumbers(chunkLines.map((line) => line.slice(1)).join('\n'))
  if (stripped === undefined) return undefined
  const bodies = stripped.split('\n')
  return chunkLines.map((line, index) => line[0] + bodies[index])
}

/** Replacement lines for one located hunk; unchanged text comes from the file when tolerant. */
function replacementLines(
  chunkLines: readonly string[],
  fileOld: readonly string[],
  tolerant: boolean
): string[] {
  const result: string[] = []
  let oldPos = 0
  let index = 0
  while (index < chunkLines.length) {
    const line = chunkLines[index]
    if (line.startsWith(' ')) {
      result.push(tolerant ? fileOld[oldPos] : line.slice(1))
      oldPos++
      index++
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    while (index < chunkLines.length && !chunkLines[index].startsWith(' ')) {
      if (chunkLines[index].startsWith('-')) removed.push(chunkLines[index].slice(1))
      else added.push(chunkLines[index].slice(1))
      index++
    }
    const fileRemoved = fileOld.slice(oldPos, oldPos + removed.length)
    oldPos += removed.length
    if (tolerant && removed.length && added.length) {
      const carried = carryOriginalCharacters(
        fileRemoved.join('\n'),
        removed.join('\n'),
        added.join('\n')
      )
      result.push(...(carried === undefined ? added : carried.split('\n')))
    } else {
      result.push(...added)
    }
  }
  return result
}

/** Apply a verified Update File operation to one in-memory file. */
export function applyCanonicalUpdate(
  original: string,
  operation: Extract<CanonicalPatchOperation, { type: 'update' }>
): string {
  const file = splitFile(original)
  const lines = [...file.lines]
  const endings = [...file.endings]
  let cursor = 0

  for (const rawChunk of operation.chunks) {
    let chunk = rawChunk
    let searchStart = cursor
    if (chunk.marker) {
      const marker = chunk.marker
      const markerMatches = (same: (line: string) => boolean) =>
        lines.flatMap((line, index) => (index >= cursor && same(line) ? [index] : []))
      let found = markerMatches((line) => line.includes(marker))
      if (!found.length) {
        const wanted = normalizeLine(marker)
        found = markerMatches((line) => normalizeLine(line).includes(wanted))
      }
      if (!found.length) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: @@ marker not found: ${marker}`
        )
      }
      if (found.length > 1) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: @@ marker is ambiguous (${found.length} matches): ${marker}`
        )
      }
      searchStart = found[0]
    }

    const oldOf = (hunk: string[]) =>
      hunk
        .filter((line) => line.startsWith(' ') || line.startsWith('-'))
        .map((line) => line.slice(1))
    let oldLines = oldOf(chunk.lines)
    const newLines = () =>
      chunk.lines
        .filter((line) => line.startsWith(' ') || line.startsWith('+'))
        .map((line) => line.slice(1))

    // Offer a concrete correction for the observed model typo, but never apply
    // it automatically or relax exact matching. The caller must resubmit.
    let spacingHint = ''
    const plain = newLines()
    if (
      oldLines.length === 1 &&
      plain.length === 1 &&
      oldLines[0].startsWith(' ') &&
      plain[0].startsWith(' ') &&
      oldLines[0].length < 500 &&
      plain[0].length < 500
    ) {
      const candidate = oldLines[0].slice(1)
      const positions = lines.flatMap((line, index) =>
        index >= searchStart && line === candidate ? [index] : []
      )
      if (positions.length === 1 && (!chunk.endOfFile || positions[0] === lines.length - 1)) {
        spacingHint = ` Possible separator-space typo: the unique source line is ${JSON.stringify(candidate)}. If the extra spaces were unintended, replace ONLY the two changed hunk lines with:\n-${candidate}\n+${plain[0].slice(1)}\nKeep the full patch envelope and all other requested operations. Review this suggestion; no changes were made.`
      }
    }

    let location: HunkLocation
    if (chunk.endOfFile) {
      const index = lines.length - oldLines.length
      const exact = index >= searchStart && sequenceMatches(lines, oldLines, index, exactLine)
      if (
        !exact &&
        !(index >= searchStart && sequenceMatches(lines, oldLines, index, tolerantLine))
      ) {
        // Models often write *** End of File where they mean the end of the patch. Say where the
        // text actually is so the next call drops the anchor instead of guessing again.
        const elsewhere = oldLines.length ? matchesFrom(lines, oldLines, 0, tolerantLine) : []
        const misplaced =
          elsewhere.length === 1
            ? ` These lines are at line ${elsewhere[0] + 1}, not at the end of the file: remove the *** End of File line (it anchors a hunk to the last lines of the file; it does not end the patch).`
            : ''
        throw new Error(
          `Patch could not be applied to ${operation.path}: End of File context does not match the file end.${misplaced} ${PATCH_WHITESPACE_HELP}${spacingHint}`
        )
      }
      location = { index, tolerant: !exact }
    } else if (!oldLines.length) {
      if (lines.length && !chunk.marker) {
        throw new Error(
          `Patch could not be applied to ${operation.path}: insertion-only hunks require an @@ marker or at least one unchanged context line to locate them`
        )
      }
      location = { index: chunk.marker ? searchStart + 1 : 0, tolerant: false }
    } else {
      try {
        location = locateHunk(lines, oldLines, searchStart, operation.path)
      } catch (error) {
        // Text copied from the read tool may still carry its `N: ` line prefixes.
        const unnumbered = withoutReadLineNumbers(chunk.lines)
        if (!unnumbered || !(error instanceof Error) || !/stale or missing/.test(error.message)) {
          if (spacingHint && error instanceof Error) throw new Error(error.message + spacingHint)
          throw error
        }
        chunk = { ...chunk, lines: unnumbered }
        oldLines = oldOf(chunk.lines)
        location = locateHunk(lines, oldLines, searchStart, operation.path)
      }
    }

    const fileOld = lines.slice(location.index, location.index + oldLines.length)
    const replacement = replacementLines(chunk.lines, fileOld, location.tolerant)
    const removedEndings = endings.slice(location.index, location.index + oldLines.length)
    const replacementEndings = replacement.map(
      (_, index) => removedEndings[Math.min(index, removedEndings.length - 1)] ?? file.dominant
    )
    lines.splice(location.index, oldLines.length, ...replacement)
    endings.splice(location.index, oldLines.length, ...replacementEndings)
    cursor = location.index + replacement.length
  }

  // Only the final line may lack a terminator, and only when the original file had none.
  for (let index = 0; index < endings.length; index++) {
    if (!endings[index]) endings[index] = file.dominant
  }
  if (endings.length && !file.trailingNewline) endings[endings.length - 1] = ''
  const result = lines.map((line, index) => line + endings[index]).join('')
  if (result === original)
    throw new Error(`Patch rejected: update produced no changes for ${operation.path}`)
  return result
}
