import { describe, expect, it } from 'vitest'
import {
  describeMatchLocations,
  findLineBlockSpans,
  findNearMiss,
  looseLine,
  reindentLineBlock,
  trimEditBoundaries
} from './lineBlockMatch'

describe('looseLine', () => {
  it('ignores indentation, inner whitespace runs and typography', () => {
    expect(looseLine('\t  say  “hi”  —  now  ')).toBe('say "hi" - now')
  })
})

describe('trimEditBoundaries', () => {
  it('removes edge blank lines from old_string and the same count from new_string', () => {
    expect(trimEditBoundaries('\nold\n\n', '\nnew\n\n')).toEqual({
      oldText: 'old',
      newText: 'new',
      droppedTrailingNewline: true
    })
  })

  it('keeps new_string text that is not an edge newline', () => {
    expect(trimEditBoundaries('old\n', 'new')).toMatchObject({ oldText: 'old', newText: 'new' })
  })

  it('returns undefined when there is nothing to trim or nothing left', () => {
    expect(trimEditBoundaries('old', 'new')).toBeUndefined()
    expect(trimEditBoundaries('\n\n', 'x')).toBeUndefined()
  })
})

describe('findLineBlockSpans', () => {
  it('matches whole lines only and returns spans without the final line ending', () => {
    const content = 'a\r\n    b  c\r\n    d\r\ne'
    const [match, ...rest] = findLineBlockSpans(content, 'b c\nd')
    expect(rest).toEqual([])
    expect(match.line).toBe(1)
    expect(content.slice(match.start, match.end)).toBe('    b  c\r\n    d')
    expect(findLineBlockSpans('xb c\n', 'b c')).toEqual([])
  })
})

describe('reindentLineBlock', () => {
  it('copies kept lines from the file and nests added lines by matching model indentation', () => {
    const original = 'if (a) {\n        call();\n    }'
    const result = reindentLineBlock(
      original,
      'if (a) {\n    call();\n}',
      'if (a) {\n    call();\n    more();\n}'
    )
    expect(result).toBe('if (a) {\n        call();\n        more();\n    }')
  })
})

describe('findNearMiss', () => {
  it('anchors on the first and last lines and lists the differing lines', () => {
    const content = 'x\nstart\nkeep\nfile only\nend\ny'
    expect(findNearMiss(content, 'start\nkeep\nmodel only\nend')).toEqual({
      startLine: 2,
      endLine: 5,
      sameLines: 3,
      totalLines: 4,
      differences: expect.arrayContaining([
        '  old_string line 3 (not in file): model only',
        '  file line 4 (not in old_string): file only'
      ])
    })
  })

  it('returns undefined for a single line or a mostly different block', () => {
    expect(findNearMiss('a\nb\n', 'a')).toBeUndefined()
    expect(findNearMiss('a\nb\nc\nd\n', 'a\nx\ny\nz')).toBeUndefined()
  })
})

describe('describeMatchLocations', () => {
  it('shows the line before each match start', () => {
    expect(describeMatchLocations('one\ntwo\nthree\ntwo', [2, 4])).toBe(
      '  1: one\n  2: two\n  ---\n  3: three\n  4: two'
    )
  })
})
