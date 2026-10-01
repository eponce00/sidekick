import { describe, expect, it } from 'vitest'
import {
  carryOriginalCharacters,
  closestRegion,
  diffSequences,
  findTolerantSpans,
  normalizeForMatch,
  stripReadLineNumbers
} from './tolerantMatch'

describe('normalizeForMatch', () => {
  it('maps typography, line endings, trailing whitespace and invisible marks with covering ranges', () => {
    const input = 'A “quote” — ok  \r\n⚠️ low x'
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
  const file =
    'intro\r\n| **Flood** | ✅ “Area of Minimal Flood Hazard,” — Zone X |  \r\n| ⚠️ Expected low |\r\n'

  it('finds ASCII copies of curly quotes and dashes and returns the original span', () => {
    const spans = findTolerantSpans(
      file,
      '| **Flood** | ✅ "Area of Minimal Flood Hazard," - Zone X |\n'
    )
    expect(spans).toHaveLength(1)
    expect(file.slice(spans[0].start, spans[0].end)).toBe(
      '| **Flood** | ✅ “Area of Minimal Flood Hazard,” — Zone X |  \r\n'
    )
  })

  it('ignores a dropped emoji variation selector', () => {
    const spans = findTolerantSpans(file, '| ⚠ Expected low |')
    expect(spans).toHaveLength(1)
    expect(file.slice(spans[0].start, spans[0].end)).toBe('| ⚠️ Expected low |')
  })

  it('reports every candidate so callers can require uniqueness', () => {
    expect(findTolerantSpans('x “a” y\nx "a" y\n', 'x "a" y')).toHaveLength(2)
  })

  it('does not match whitespace-only needles', () => {
    expect(findTolerantSpans('a \n b', '  ')).toEqual([])
  })
})

describe('carryOriginalCharacters', () => {
  it('keeps the file’s typography in unchanged text and uses the model’s new text', () => {
    const original = 'Status “unknown” — confirm via the “WUI” map.'
    const modelOld = 'Status "unknown" - confirm via the "WUI" map.'
    const modelNew = 'Status "confirmed" - verified on the "WUI" map.'
    expect(carryOriginalCharacters(original, modelOld, modelNew)).toBe(
      'Status “confirmed” — verified on the “WUI” map.'
    )
  })

  it('preserves CRLF, trailing spaces and invisible marks the model did not reproduce', () => {
    const original = 'one  \r\n| ⚠️ Expected low |\r\nthree\r\n'
    const modelOld = 'one\n| ⚠ Expected low |\nthree\n'
    const modelNew = 'one\n| ✅ Confirmed |\nthree\n'
    expect(carryOriginalCharacters(original, modelOld, modelNew)).toBe(
      'one  \r\n| ✅ Confirmed |\r\nthree\r\n'
    )
  })

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

describe('stripReadLineNumbers', () => {
  it('strips read-tool prefixes only when every non-empty line has one', () => {
    expect(stripReadLineNumbers('12: const a = 1\n13:   return a\n')).toBe(
      'const a = 1\n  return a\n'
    )
    expect(stripReadLineNumbers('12: const a = 1\nreturn a')).toBeUndefined()
  })
})

describe('closestRegion', () => {
  it('points at the most similar lines with line numbers', () => {
    const file = Array.from({ length: 30 }, (_, index) => `line ${index + 1} text`).join('\n')
    const region = closestRegion(file, 'line 17 texts\nline 18 text')
    expect(region).toContain('17: line 17 text')
    expect(region).toContain('18: line 18 text')
  })
})
