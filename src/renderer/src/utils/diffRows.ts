export type DiffRowKind = 'header' | 'hunk' | 'add' | 'delete' | 'context'

/** One line of a unified diff, numbered in the old and new file where it exists there. */
export interface DiffRow {
  index: number
  kind: DiffRowKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface SplitDiffCell {
  index: number
  text: string
  line?: number
  kind: DiffRowKind
}

export interface SplitDiffRow {
  marker?: string
  left?: SplitDiffCell
  right?: SplitDiffCell
}

/** Lines a comment can quote: the ones that belong to a file, not the diff's own headers. */
export function isCommentableDiffRow(row: Pick<DiffRow, 'oldLine' | 'newLine'>): boolean {
  return row.oldLine !== undefined || row.newLine !== undefined
}

export function parseDiffRows(diff: string): DiffRow[] {
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  return diff.split(/\r?\n/).map((text, index): DiffRow => {
    if (text.startsWith('+++ ') || text.startsWith('--- ') || text.startsWith('diff ')) {
      if (text.startsWith('diff ')) inHunk = false
      return { index, kind: 'header', text }
    }
    const hunk = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (text.startsWith('@@')) {
      inHunk = Boolean(hunk)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
      }
      return { index, kind: 'hunk', text }
    }
    if (text.startsWith('+')) {
      return inHunk
        ? { index, kind: 'add', text, newLine: newLine++ }
        : { index, kind: 'add', text }
    }
    if (text.startsWith('-')) {
      return inHunk
        ? { index, kind: 'delete', text, oldLine: oldLine++ }
        : { index, kind: 'delete', text }
    }
    // "\ No newline at end of file" and lines outside a hunk have no place in either file.
    if (!inHunk || text.startsWith('\\')) return { index, kind: 'context', text }
    return { index, kind: 'context', text, oldLine: oldLine++, newLine: newLine++ }
  })
}

/** Side by side: removed lines pair with the added lines that replaced them. */
export function splitDiffRows(rows: readonly DiffRow[]): SplitDiffRow[] {
  const split: SplitDiffRow[] = []
  for (let position = 0; position < rows.length; ) {
    const row = rows[position]
    if (row.kind === 'delete' && row.oldLine !== undefined) {
      const deleted: DiffRow[] = []
      const added: DiffRow[] = []
      while (rows[position]?.kind === 'delete' && rows[position].oldLine !== undefined) {
        deleted.push(rows[position++])
      }
      while (rows[position]?.kind === 'add' && rows[position].newLine !== undefined) {
        added.push(rows[position++])
      }
      for (let pair = 0; pair < Math.max(deleted.length, added.length); pair++) {
        const left = deleted[pair]
        const right = added[pair]
        split.push({
          ...(left
            ? { left: { index: left.index, text: left.text, line: left.oldLine, kind: 'delete' } }
            : {}),
          ...(right
            ? { right: { index: right.index, text: right.text, line: right.newLine, kind: 'add' } }
            : {})
        })
      }
      continue
    }
    position++
    if (row.kind === 'add' && row.newLine !== undefined) {
      split.push({ right: { index: row.index, text: row.text, line: row.newLine, kind: 'add' } })
    } else if (row.kind === 'context' && isCommentableDiffRow(row)) {
      split.push({
        left: { index: row.index, text: row.text, line: row.oldLine, kind: 'context' },
        right: { index: row.index, text: row.text, line: row.newLine, kind: 'context' }
      })
    } else {
      split.push({ marker: row.text })
    }
  }
  return split
}

export const MAX_COMMENT_EXCERPT_LINES = 200

export interface DiffLineSelection {
  /** "new" numbers lines in the changed file; "old" is used when only removed lines are chosen. */
  side: 'new' | 'old'
  startLine: number
  endLine: number
  /** The chosen diff lines, with their +/- markers. */
  excerpt: string
}

/** What a comment on the rows between two clicked lines refers to. */
export function selectDiffLines(
  rows: readonly DiffRow[],
  anchor: number,
  focus: number
): DiffLineSelection | null {
  const from = Math.min(anchor, focus)
  const to = Math.max(anchor, focus)
  const picked = rows.slice(from, to + 1).filter(isCommentableDiffRow)
  if (!picked.length) return null
  const newLines = picked.flatMap((row) => (row.newLine === undefined ? [] : [row.newLine]))
  const side = newLines.length ? 'new' : 'old'
  const lines = newLines.length
    ? newLines
    : picked.flatMap((row) => (row.oldLine === undefined ? [] : [row.oldLine]))
  return {
    side,
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    excerpt: picked
      .slice(0, MAX_COMMENT_EXCERPT_LINES)
      .map((row) => row.text)
      .join('\n')
  }
}
