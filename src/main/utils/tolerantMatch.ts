/**
 * Locate text a model copied from a file when its copy differs only in ways that do not change
 * meaning, and carry the file's own characters into the replacement.
 *
 * Models routinely retype curly quotes, dashes and non-breaking spaces as ASCII, drop trailing
 * whitespace, drop emoji variation selectors, and send LF for CRLF files. Exact matching then
 * fails on text the model has read correctly, and an accepted ASCII copy would silently rewrite
 * the file's typography. The same normalization is used by Codex's patch matcher and Qwen Code's
 * edit tool; unlike Codex, a tolerant match is accepted only when it is unique.
 */

/** Characters that models commonly substitute, mapped to the ASCII they are typed as. */
const TYPOGRAPHY: Record<string, string> = {
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  '\u2026': '...',
  '\u00A0': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  '\u2007': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200A': ' ',
  '\u202F': ' ',
  '\u205F': ' ',
  '\u3000': ' '
}

/** Invisible code points that render identically with or without them. */
const INVISIBLE = new Set(['\uFE0E', '\uFE0F', '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'])

/**
 * Normalized text plus, for each normalized character, the range of original characters it
 * stands for. Dropped characters are attached to a neighbour so the ranges cover the input:
 * a CR and trailing whitespace belong to the newline after them, invisible marks to the
 * character before them.
 */
export interface NormalizedText {
  text: string
  start: number[]
  end: number[]
}

export function normalizeForMatch(input: string): NormalizedText {
  let text = ''
  const start: number[] = []
  const end: number[] = []
  let pending = -1 // first index of dropped characters waiting for the next newline
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '\r' && input[index + 1] === '\n') {
      if (pending < 0) pending = index
      continue
    }
    if (char === ' ' || char === '\t' || TYPOGRAPHY[char] === ' ') {
      // Whitespace is dropped only when nothing but whitespace follows it on its line.
      let probe = index
      while (
        probe < input.length &&
        (input[probe] === ' ' || input[probe] === '\t' || TYPOGRAPHY[input[probe]] === ' ')
      )
        probe++
      if (input[probe] === '\n' || (input[probe] === '\r' && input[probe + 1] === '\n')) {
        if (pending < 0) pending = index
        index = probe - 1
        continue
      }
    }
    if (INVISIBLE.has(char)) {
      if (end.length) end[end.length - 1] = index + 1
      else if (pending < 0) pending = index
      continue
    }
    const mapped = TYPOGRAPHY[char] ?? char
    const from = pending >= 0 ? pending : index
    pending = -1
    for (let offset = 0; offset < mapped.length; offset++) {
      text += mapped[offset]
      // A multi-character expansion (an ellipsis) maps every part to the whole original.
      start.push(from)
      end.push(index + 1)
    }
  }
  if (pending >= 0 && end.length) end[end.length - 1] = input.length
  return { text, start, end }
}

export interface TextSpan {
  start: number
  end: number
}

function occurrences(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = []
  if (!needle) return found
  let index = haystack.indexOf(needle)
  while (index >= 0 && found.length < limit) {
    found.push(index)
    index = haystack.indexOf(needle, index + needle.length)
  }
  return found
}

/**
 * Find `needle` in `content` ignoring line endings, trailing whitespace, typographic
 * substitutions and invisible marks. Returns the matching spans of the original content.
 */
export function findTolerantSpans(content: string, needle: string, limit = 50): TextSpan[] {
  const file = normalizeForMatch(content)
  const target = normalizeForMatch(needle).text
  if (!target.trim()) return []
  return occurrences(file.text, target, limit).map((index) => ({
    start: file.start[index],
    end: file.end[index + target.length - 1]
  }))
}

/** Normalized form of one line, used by line-based patch matching. */
export function normalizeLine(line: string): string {
  return normalizeForMatch(line).text.replace(/[ \t]+$/, '')
}

const LINE_NUMBER_PREFIX = /^\s*\d+: ?/

/**
 * Remove the `N: ` prefixes the read tool shows, but only when every non-empty line has one,
 * so source text that merely starts with digits and a colon is never altered.
 */
export function stripReadLineNumbers(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.trim())
  if (!nonEmpty.length || !nonEmpty.every((line) => LINE_NUMBER_PREFIX.test(line))) return undefined
  return lines.map((line) => line.replace(LINE_NUMBER_PREFIX, '')).join('\n')
}

type DiffOp = { kind: 'equal' | 'insert' | 'delete'; a: number; b: number; length: number }

/**
 * Myers O(ND) diff over two sequences; returns runs in order, or undefined when the sequences
 * differ by more than `maxCost` edits. Each trace step keeps only its active diagonals, so memory
 * grows with the square of the edit distance rather than with the input length.
 */
export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  maxCost = 2_000
): DiffOp[] | undefined {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  const n = aMid.length
  const m = bMid.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] holds diagonals -(d+1)..(d+1) as they were before step d, at index k + d + 1.
  const trace: Int32Array[] = []
  let done = max === 0
  for (let d = 0; d <= max && !done; d++) {
    if (d > maxCost) return undefined
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && aMid[x] === bMid[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }
  // Walk the trace back into single-element steps, then merge them into runs.
  const steps: Array<'equal' | 'insert' | 'delete'> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]
    const at = (k: number) => vd[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      steps.push('equal')
      x--
      y--
    }
    steps.push(x === prevX ? 'insert' : 'delete')
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    steps.push('equal')
    x--
    y--
  }
  steps.reverse()
  const ops: DiffOp[] = []
  const push = (kind: DiffOp['kind'], a: number, b: number) => {
    const last = ops.at(-1)
    if (last && last.kind === kind) last.length++
    else ops.push({ kind, a, b, length: 1 })
  }
  for (let index = 0; index < prefix; index++) push('equal', index, index)
  let ai = prefix
  let bi = prefix
  for (const step of steps) {
    push(step, ai, bi)
    if (step !== 'insert') ai++
    if (step !== 'delete') bi++
  }
  for (let index = 0; index < suffix; index++) push('equal', ai + index, bi + index)
  return ops
}

/**
 * Build the text that replaces `original` (the matched file span) when the model described that
 * span as `modelOld` and wants `modelNew`. Characters the model kept from `modelOld` are copied
 * from the file instead of the model's retyped version; characters it added are used as written.
 * Returns undefined when the inputs are too large or too different to align confidently.
 */
export function carryOriginalCharacters(
  original: string,
  modelOld: string,
  modelNew: string
): string | undefined {
  // Whitespace ending the span is formatting the file owns (a Markdown hard break, say); keep
  // it whatever happens to the last word, and ignore the model's retyping of it.
  const tail = /[ \t\u00A0]*$/.exec(original)![0]
  const body = original.slice(0, original.length - tail.length)
  const result = carryBody(
    body,
    modelOld.replace(/[ \t\u00A0]+$/, ''),
    modelNew.replace(/[ \t\u00A0]+$/, '')
  )
  return result === undefined ? undefined : result + tail
}

function carryBody(original: string, modelOld: string, modelNew: string): string | undefined {
  const file = normalizeForMatch(original)
  const old = normalizeForMatch(modelOld)
  if (file.text !== old.text) return undefined
  // Align the model's old and new text word by word in normalized form; character-level
  // alignment pairs unrelated letters and would drop the file's quotes around a changed word.
  const next = normalizeForMatch(modelNew)
  const oldTokens = tokens(old.text)
  const newTokens = tokens(next.text)
  const ops = diffSequences(
    oldTokens.map((token) => token.text),
    newTokens.map((token) => token.text)
  )
  if (!ops) return undefined
  let result = ''
  let copiedThrough = 0 // original index already emitted
  for (const op of ops) {
    if (op.kind === 'equal') {
      const from = file.start[oldTokens[op.a].start]
      const last = oldTokens[op.a + op.length - 1]
      const to = file.end[last.start + last.text.length - 1]
      result += original.slice(Math.max(from, copiedThrough), to)
      copiedThrough = Math.max(copiedThrough, to)
    } else if (op.kind === 'insert') {
      const first = newTokens[op.b]
      const last = newTokens[op.b + op.length - 1]
      result += modelNew.slice(next.start[first.start], next.end[last.start + last.text.length - 1])
    } else {
      const last = oldTokens[op.a + op.length - 1]
      copiedThrough = Math.max(copiedThrough, file.end[last.start + last.text.length - 1])
    }
  }
  return result
}

/** Words, numbers and single other characters, with their offsets in the text. */
function tokens(text: string): Array<{ text: string; start: number }> {
  const result: Array<{ text: string; start: number }> = []
  for (const match of text.matchAll(/[\p{L}\p{N}_]+|[\s\S]/gu)) {
    result.push({ text: match[0], start: match.index })
  }
  return result
}

/** A short excerpt of the region most similar to `needle`, with 1-based line numbers. */
export function closestRegion(content: string, needle: string, context = 2): string | undefined {
  const fileLines = content.replace(/\r\n/g, '\n').split('\n')
  const wanted = needle
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter((line) => line.trim())
  if (!wanted.length || fileLines.length > 200_000) return undefined
  const normalized = fileLines.map(normalizeLine)
  const anchor = wanted.reduce((best, line) =>
    line.trim().length > best.trim().length ? line : best
  )
  let bestIndex = -1
  let bestScore = 0
  for (let index = 0; index < normalized.length; index++) {
    const score = similarity(normalized[index], anchor)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  if (bestIndex < 0 || bestScore < 0.5) return undefined
  const offsetInNeedle = wanted.indexOf(anchor)
  const from = Math.max(0, bestIndex - offsetInNeedle - context)
  const to = Math.min(fileLines.length, bestIndex - offsetInNeedle + wanted.length + context)
  return fileLines
    .slice(from, to)
    .map(
      (line, index) =>
        `${from + index + 1}: ${line.length > 400 ? `${line.slice(0, 400)}\u2026` : line}`
    )
    .join('\n')
}

/** Similarity of two short strings by shared character bigrams (Dice coefficient). */
function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < a.length - 1; index++) {
    const pair = a.slice(index, index + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  let shared = 0
  for (let index = 0; index < b.length - 1; index++) {
    const pair = b.slice(index, index + 2)
    const count = counts.get(pair) ?? 0
    if (count > 0) {
      shared++
      counts.set(pair, count - 1)
    }
  }
  return (2 * shared) / (a.length + b.length - 2)
}
