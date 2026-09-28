import { describe, expect, it } from 'vitest'
import { isCommentableDiffRow, parseDiffRows, selectDiffLines, splitDiffRows } from './diffRows'

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,4 @@',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  ' tail',
  '\\ No newline at end of file'
].join('\n')

describe('parseDiffRows', () => {
  it('numbers each line in the old and new file from the hunk header', () => {
    const rows = parseDiffRows(diff)
    expect(rows.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine])).toEqual([
      ['header', undefined, undefined],
      ['header', undefined, undefined],
      ['header', undefined, undefined],
      ['hunk', undefined, undefined],
      ['context', 10, 10],
      ['delete', 11, undefined],
      ['delete', 12, undefined],
      ['add', undefined, 11],
      ['context', 13, 12],
      ['context', undefined, undefined]
    ])
    expect(rows.filter(isCommentableDiffRow)).toHaveLength(5)
  })
})

describe('splitDiffRows', () => {
  it('pairs removed lines with their replacements and keeps each cell’s row index', () => {
    const split = splitDiffRows(parseDiffRows(diff))
    expect(split.filter((row) => row.marker !== undefined)).toHaveLength(5)
    const cells = split.filter((row) => row.marker === undefined)
    expect(cells[1]).toEqual({
      left: { index: 5, text: '-old one', line: 11, kind: 'delete' },
      right: { index: 7, text: '+new one', line: 11, kind: 'add' }
    })
    expect(cells[2]).toEqual({ left: { index: 6, text: '-old two', line: 12, kind: 'delete' } })
  })
})

describe('selectDiffLines', () => {
  const rows = parseDiffRows(diff)

  it('uses new-file numbers and quotes the selected diff lines in order', () => {
    expect(selectDiffLines(rows, 8, 4)).toEqual({
      side: 'new',
      startLine: 10,
      endLine: 12,
      excerpt: [' keep', '-old one', '-old two', '+new one', ' tail'].join('\n')
    })
  })

  it('uses old-file numbers when only removed lines are chosen', () => {
    expect(selectDiffLines(rows, 5, 6)).toMatchObject({ side: 'old', startLine: 11, endLine: 12 })
  })

  it('ignores headers', () => {
    expect(selectDiffLines(rows, 0, 3)).toBeNull()
  })
})
