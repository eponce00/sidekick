/**
 * Line-level fallbacks for the edit tool, tried after exact and character-tolerant matching.
 *
 * Models copy whole lines correctly but drift in ways the character matcher does not forgive:
 * extra or missing blank lines and newlines at the edges of old_string, and indentation retyped
 * at a different depth (or tabs as spaces). OpenCode chains similar replacers (trimmed boundary,
 * line-trimmed, indentation-flexible). Unlike OpenCode, every fallback here is accepted only when
 * it identifies one location, and a block whose middle differs from the file (OpenCode's
 * block-anchor replacer) is never applied: it is reported back with the differing lines, because
 * text the model has not seen may be what differs.
 */
import { diffSequences, normalizeForMatch, type TextSpan } from './tolerantMatch'

/** A line compared without indentation, runs of inner whitespace, typography or invisibles. */
export function looseLine(line: string): string {
  return normalizeForMatch(line).text.trim().replace(/\s+/g, ' ')
}

interface FileLine {
  text: string
  start: number
  end: number // exclusive, before the line ending
}

function fileLines(content: string): FileLine[] {
  const lines: FileLine[] = []
  let start = 0
  for (const match of content.matchAll(/\r?\n/g)) {
    lines.push({ text: content.slice(start, match.index), start, end: match.index })
    start = match.index + match[0].length
  }
  lines.push({ text: content.slice(start), start, end: content.length })
  return lines
}

const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/
const TRAILING_BLANK_LINES = /(?:\r?\n[ \t]*)+$/

function newlineCount(text: string): number {
  return text.match(/\n/g)?.length ?? 0
}

export interface TrimmedEdit {
  oldText: string
  newText: string
  /** The model's old_string ended with a line ending that the trimmed text no longer has. */
  droppedTrailingNewline: boolean
}

/**
 * Remove blank lines and newlines at the edges of old_string, and the same number from
 * new_string where it has them, so the edit means the same without its edge whitespace.
 * Returns undefined when old_string has no such edges.
 */
export function trimEditBoundaries(oldText: string, newText: string): TrimmedEdit | undefined {
  const lead = LEADING_BLANK_LINES.exec(oldText)?.[0] ?? ''
  const trail = TRAILING_BLANK_LINES.exec(oldText.slice(lead.length))?.[0] ?? ''
  if (!lead && !trail) return undefined
  const body = oldText.slice(lead.length, oldText.length - trail.length)
  if (!body.trim()) return undefined
  let next = newText
  for (let count = newlineCount(lead); count > 0; count--) {
    const stripped = next.replace(/^[ \t]*\r?\n/, '')
    if (stripped === next) break
    next = stripped
  }
  for (let count = newlineCount(trail); count > 0; count--) {
    const stripped = next.replace(/\r?\n[ \t]*$/, '')
    if (stripped === next) break
    next = stripped
  }
  return { oldText: body, newText: next, droppedTrailingNewline: trail.includes('\n') }
}

export interface LineBlockMatch extends TextSpan {
  /** 0-based index of the first matched file line. */
  line: number
}

/**
 * Find old_string as a run of whole file lines, comparing lines with `looseLine`. Returns the
 * spans of the matched lines without their final line ending; old_string's edge blank lines
 * are ignored.
 */
export function findLineBlockSpans(content: string, needle: string, limit = 50): LineBlockMatch[] {
  const wanted = (trimEditBoundaries(needle, '')?.oldText ?? needle).split(/\r?\n/).map(looseLine)
  if (!wanted.some(Boolean)) return []
  const lines = fileLines(content)
  if (lines.length > 200_000) return []
  const loose = lines.map((line) => looseLine(line.text))
  const matches: LineBlockMatch[] = []
  for (let index = 0; index + wanted.length <= loose.length; index++) {
    let offset = 0
    while (offset < wanted.length && loose[index + offset] === wanted[offset]) offset++
    if (offset < wanted.length) continue
    matches.push({
      line: index,
      start: lines[index].start,
      end: lines[index + wanted.length - 1].end
    })
    if (matches.length >= limit) break
    index += wanted.length - 1
  }
  return matches
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/**
 * Build the text that replaces a line block matched by `findLineBlockSpans`. Lines the model
 * kept are copied from the file. Lines it added or changed take the file indentation of the
 * matched lines that had the same model indentation (so two-space copies of four-space code nest
 * correctly), or else are shifted by the offset between the first non-blank lines.
 */
export function reindentLineBlock(
  original: string,
  modelOld: string,
  modelNew: string
): string | undefined {
  const fileBlock = original.split(/\r?\n/)
  const oldLines = (trimEditBoundaries(modelOld, '')?.oldText ?? modelOld).split(/\r?\n/)
  if (oldLines.length !== fileBlock.length) return undefined
  if (!modelNew) return ''
  const newLines = modelNew.split(/\r?\n/)
  const ending = original.includes('\r\n') ? '\r\n' : '\n'
  const indentMap = new Map<string, string>()
  oldLines.forEach((line, index) => {
    const indent = leadingWhitespace(line)
    if (line.trim() && !indentMap.has(indent))
      indentMap.set(indent, leadingWhitespace(fileBlock[index]))
  })
  const anchor = oldLines.findIndex((line) => line.trim())
  const modelIndent = anchor < 0 ? '' : leadingWhitespace(oldLines[anchor])
  const fileIndent = anchor < 0 ? '' : leadingWhitespace(fileBlock[anchor])
  const reindent = (line: string): string => {
    if (!line.trim()) return line
    const indent = leadingWhitespace(line)
    const mapped = indentMap.get(indent)
    if (mapped !== undefined) return mapped + line.slice(indent.length)
    return indent.startsWith(modelIndent) ? fileIndent + line.slice(modelIndent.length) : line
  }
  const ops = diffSequences(oldLines.map(looseLine), newLines.map(looseLine))
  if (!ops) return newLines.map(reindent).join(ending)
  const result: string[] = []
  for (const op of ops) {
    if (op.kind === 'equal') result.push(...fileBlock.slice(op.a, op.a + op.length))
    else if (op.kind === 'insert')
      result.push(...newLines.slice(op.b, op.b + op.length).map(reindent))
  }
  return result.join(ending)
}

export interface NearMiss {
  /** 1-based first and last file lines of the closest block. */
  startLine: number
  endLine: number
  sameLines: number
  totalLines: number
  /** Lines of old_string missing from the file block, and file lines old_string lacks. */
  differences: string[]
}

const MAX_DIFFERENCE_LINES = 12

function clip(text: string, length = 200): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/**
 * For a multi-line old_string that matched nowhere, find the file block it was most likely
 * copied from (anchored on its first or last line) and list the lines that differ.
 */
export function findNearMiss(content: string, needle: string): NearMiss | undefined {
  const modelLines = (trimEditBoundaries(needle, '')?.oldText ?? needle).split(/\r?\n/)
  const wanted = modelLines.map(looseLine)
  if (wanted.filter(Boolean).length < 2 || wanted.length > 5_000) return undefined
  const lines = fileLines(content)
  if (lines.length > 200_000) return undefined
  const loose = lines.map((line) => looseLine(line.text))
  const first = wanted.find(Boolean)!
  const last = wanted.findLast(Boolean)!
  const firstOffset = wanted.indexOf(first)
  const lastOffset = wanted.length - 1 - wanted.lastIndexOf(last)
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < loose.length; index++) {
    if (loose[index] === first) starts.push(Math.max(0, index - firstOffset))
    if (loose[index] === last) ends.push(Math.min(loose.length - 1, index + lastOffset))
  }
  const windows: Array<[number, number]> = []
  for (const start of starts.slice(0, 40)) {
    // Prefer the nearest end anchor that keeps the block within half to twice its length.
    const end = ends
      .filter(
        (end) => end >= start && Math.abs(end - start + 1 - wanted.length) <= wanted.length / 2
      )
      .sort(
        (a, b) => Math.abs(a - start + 1 - wanted.length) - Math.abs(b - start + 1 - wanted.length)
      )[0]
    windows.push([start, end ?? Math.min(loose.length - 1, start + wanted.length - 1)])
  }
  for (const end of ends.slice(0, 40)) windows.push([Math.max(0, end - wanted.length + 1), end])
  let best:
    | { start: number; end: number; same: number; ops: ReturnType<typeof diffSequences> }
    | undefined
  for (const [start, end] of windows) {
    const ops = diffSequences(wanted, loose.slice(start, end + 1), 400)
    if (!ops) continue
    const same = ops.reduce((total, op) => total + (op.kind === 'equal' ? op.length : 0), 0)
    if (!best || same > best.same) best = { start, end, same, ops }
  }
  if (!best?.ops || best.same * 2 < wanted.length) return undefined
  const differences: string[] = []
  let omitted = 0
  for (const op of best.ops) {
    if (op.kind === 'equal') continue
    for (let offset = 0; offset < op.length; offset++) {
      if (differences.length >= MAX_DIFFERENCE_LINES) {
        omitted++
        continue
      }
      differences.push(
        op.kind === 'delete'
          ? `  old_string line ${op.a + offset + 1} (not in file): ${clip(modelLines[op.a + offset])}`
          : `  file line ${best.start + op.b + offset + 1} (not in old_string): ${clip(lines[best.start + op.b + offset].text)}`
      )
    }
  }
  if (omitted) differences.push(`  … ${omitted} more differing lines`)
  return {
    startLine: best.start + 1,
    endLine: best.end + 1,
    sameLines: best.same,
    totalLines: wanted.length,
    differences
  }
}

/** Short excerpts showing where each match of an ambiguous old_string begins. */
export function describeMatchLocations(content: string, startLines: readonly number[]): string {
  const lines = content.split(/\r?\n/)
  return startLines
    .slice(0, 5)
    .map((lineNumber) => {
      const from = Math.max(1, lineNumber - 1)
      const excerpt: string[] = []
      for (let line = from; line <= lineNumber; line++) {
        excerpt.push(`  ${line}: ${clip(lines[line - 1] ?? '', 160)}`)
      }
      return excerpt.join('\n')
    })
    .join('\n  ---\n')
}
