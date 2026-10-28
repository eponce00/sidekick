import { describe, expect, it } from 'vitest'
import {
  carryOriginalCharacters,
  diffSequences,
  findTolerantSpans,
  normalizeForMatch
} from './tolerantMatch'

// Typography, emoji selectors, CRLF and read-tool prefixes are covered through
// canonicalPatch.test.ts and workspaceMutationService.editMatching.test.ts.

describe('normalizeForMatch', () => {
  it('maps typography, line endings, trailing whitespace and invisible marks with covering ranges', () => {
    const input = 'A “quote” — ok  \r\n⚠️ low x'
    const normalized = normalizeForMatch(input)
    expect(normalized.text).toBe('A "quote" - ok\n⚠ low x')
    // Ranges partition the input, so equal runs can be copied back byte for byte.
    expect(normalized.start[0]).toBe(0)
    expect(normalized.end.at(-1)).toBe(input.length)
    for (let index = 1; index < normalized.start.length; index++) {
      expect(normalized.start[index]).toBe(normalized.end[index - 1])
    }
    const newline = normalized.text.indexOf('\n')
    expect(input.slice(normalized.start[newline], normalized.end[newline])).toBe('  \r\n')
  })

  it('keeps whitespace that is followed by text on the same line', () => {
    expect(normalizeForMatch('a  b\t c').text).toBe('a  b\t c')
  })
})

describe('findTolerantSpans', () => {
  it('does not match whitespace-only needles', () => {
    expect(findTolerantSpans('a \n b', '  ')).toEqual([])
  })
})

describe('carryOriginalCharacters', () => {
  it('refuses spans that do not normalize to the model text', () => {
    expect(carryOriginalCharacters('abc', 'abd', 'x')).toBeUndefined()
  })
})

describe('diffSequences', () => {
  function apply(a: string[], b: string[]): string[] {
    const ops = diffSequences(a, b)
    expect(ops).toBeDefined()
    const out: string[] = []
    for (const op of ops!) {
      if (op.kind === 'equal') out.push(...a.slice(op.a, op.a + op.length))
      if (op.kind === 'insert') out.push(...b.slice(op.b, op.b + op.length))
    }
    return out
  }

  it('reconstructs the target for random edits', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let trial = 0; trial < 300; trial++) {
      const a = Array.from(
        { length: Math.floor(random() * 40) },
        () => 'abcde'[Math.floor(random() * 5)]
      )
      const b = a.filter(() => random() > 0.2)
      for (let insert = 0; insert < 4; insert++)
        b.splice(Math.floor(random() * (b.length + 1)), 0, 'xyz'[Math.floor(random() * 3)])
      expect(apply(a, b)).toEqual(b)
    }
  })

  it('gives up on inputs that differ too much', () => {
    expect(diffSequences([...'a'.repeat(50)], [...'b'.repeat(50)], 10)).toBeUndefined()
  })
})
