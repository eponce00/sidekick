import { describe, expect, it } from 'vitest'
import { applyCanonicalUpdate, parseCanonicalPatch } from './canonicalPatch'

function update(original: string, hunk: string): string {
  const [operation] = parseCanonicalPatch(
    `*** Begin Patch\n*** Update File: test.txt\n${hunk}\n*** End Patch`
  )
  if (operation.type !== 'update') throw new Error('Expected update')
  return applyCanonicalUpdate(original, operation)
}

describe('canonical patch EOF constraints', () => {
  it('accepts a single complete Markdown wrapper without guessing missing syntax', () => {
    const text = '*** Begin Patch\n*** Update File: test.txt\n@@\n-before\n+after\n*** End Patch'
    expect(parseCanonicalPatch('```diff\n' + text + '\n```')).toEqual(parseCanonicalPatch(text))
    expect(() => parseCanonicalPatch('Explanation\n' + text)).toThrow('sentinels')
  })
  it('consolidates consecutive updates into one exact ordered operation', () => {
    const ops = parseCanonicalPatch(
      '*** Begin Patch\n*** Update File: test.txt\n@@\n-one\n+ONE\n*** Update File: test.txt\n@@\n-two\n+TWO\n*** End Patch'
    )
    expect(ops).toHaveLength(1)
    if (ops[0].type !== 'update') throw new Error('Expected update')
    expect(applyCanonicalUpdate('one\ntwo\n', ops[0])).toBe('ONE\nTWO\n')
    expect(() =>
      applyCanonicalUpdate(
        'one\nexternal\n',
        ops[0] as Extract<(typeof ops)[number], { type: 'update' }>
      )
    ).toThrow()
  })
  it('does not turn delete-and-add or repeated moves into replacements', () => {
    expect(() =>
      parseCanonicalPatch(
        '*** Begin Patch\n*** Delete File: test.txt\n*** Add File: test.txt\n+replacement\n*** End Patch'
      )
    ).toThrow('one Update File')
  })
  it.each([
    '*** Update File: test.txt\n@@\n-before\n+after',
    '*** Update File: test.txt\n@@\n-before\n+after\n*** End Patch',
    '*** Begin Patch\n*** Update File: test.txt\n@@\n-before\n+after',
    "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: test.txt\n@@\n-before\n+after\n*** End Patch\nEOF"
  ])('restores a missing envelope around complete file operations', (patch) => {
    const text = '*** Begin Patch\n*** Update File: test.txt\n@@\n-before\n+after\n*** End Patch'
    expect(parseCanonicalPatch(patch)).toEqual(parseCanonicalPatch(text))
  })
  it.each([
    '-before\n+after',
    'before\nafter',
    'Explanation\n*** Update File: test.txt\n@@\n-a\n+b'
  ])('still rejects patch text that is not a file operation', (patch) => {
    expect(() => parseCanonicalPatch(patch)).toThrow('sentinels')
  })
  it.each(['*** End of Patch', '*** End of File'])(
    'reads a final %s without an End sentinel as the end of the patch',
    (ending) => {
      const [operation] = parseCanonicalPatch(
        `*** Update File: test.txt\n@@\n-target\n+changed\n${ending}`
      )
      if (operation.type !== 'update') throw new Error('Expected update')
      // The hunk is in the middle of the file, so an end-of-file anchor would reject it.
      expect(applyCanonicalUpdate('a\ntarget\nz\n', operation)).toBe('a\nchanged\nz\n')
    }
  )
  it('explains a misused End of File anchor with the real location', () => {
    expect(() => update('a\ntarget\nz\n', '@@\n-target\n+changed\n*** End of File')).toThrow(
      'These lines are at line 2, not at the end of the file'
    )
  })
  it('keeps an End of File anchor that is followed by the End sentinel', () => {
    expect(() => update('a\ntarget\nz\n', '@@\n-target\n+changed\n*** End of File')).toThrow(
      'file end'
    )
  })

  it('explains an extra prefix separator without weakening exact whitespace matching', () => {
    const original = '// Preserve café ☕\r\nexport const label = "before"\r\n'
    const wrong = '@@\n- export const label = "before"\n+ export const label = "after"'
    expect(() => update(original, wrong)).toThrow('exactly ONE character')
    expect(() => update(original, wrong)).toThrow('replace ONLY the two changed hunk lines')
    expect(() => update(original, `${wrong}\n*** End of File`)).toThrow('CRLF/LF')
    expect(
      update(original, '@@\n-export const label = "before"\n+export const label = "after"')
    ).toBe('// Preserve café ☕\r\nexport const label = "after"\r\n')
  })
  it('does not suggest whitespace repair when the source is ambiguous or violates EOF', () => {
    for (const [original, hunk] of [
      ['export\nexport\n', '@@\n- export\n+ changed'],
      ['export\nlast\n', '@@\n- export\n+ changed\n*** End of File']
    ]) {
      expect(() => update(original, hunk)).toThrow()
      try {
        update(original, hunk)
        throw new Error('Expected rejection')
      } catch (error) {
        expect(String(error)).not.toContain('Possible separator-space typo')
      }
    }
  })
  it('rejects a matching non-final hunk marked EOF', () => {
    expect(() => update('target\nother\n', '@@\n-target\n+changed\n*** End of File')).toThrow(
      'file end'
    )
  })
  it('uses EOF to disambiguate repeated lines', () => {
    expect(update('target\ntarget\n', '@@\n-target\n+changed\n*** End of File')).toBe(
      'target\nchanged\n'
    )
  })
  it('preserves CRLF and a missing terminal newline', () => {
    expect(update('first\r\ntarget', '@@\n-target\n+changed\n*** End of File')).toBe(
      'first\r\nchanged'
    )
  })
  it('supports explicit EOF insertion', () => {
    expect(update('first\n', '@@\n+last\n*** End of File')).toBe('first\nlast\n')
  })
  it('distinguishes terminal-newline preservation from an explicit added blank line', () => {
    const changed = update('target\n', '@@\n-target\n+changed')
    expect(changed).toBe('changed\n')
    const extraBlank = update('target\n', '@@\n-target\n+changed\n+')
    expect(extraBlank).toBe('changed\n\n')
    // A repair is a second real mutation, even though the final bytes are correct.
    expect(update(extraBlank, '@@\n changed\n-\n*** End of File')).toBe(changed)
  })
  it('rejects both a no-op replacement and replay of an already-applied replacement', () => {
    expect(() => update('changed\n', '@@\n-changed\n+changed')).toThrow('no changes')
    expect(() => update('changed\n', '@@\n-target\n+changed')).toThrow()
  })
  it('rejects hunks after EOF', () => {
    expect(() =>
      update('target\n', '@@\n-target\n+changed\n*** End of File\n@@\n-changed\n+other')
    ).toThrow('terminate')
  })
  it('still rejects ambiguity without EOF', () => {
    expect(() => update('target\ntarget\n', '@@\n-target\n+changed')).toThrow('ambiguous')
  })
  it('ignores unified-diff line numbers and keeps matching on context', () => {
    expect(update('target\n', '@@ -1 +1 @@\n-target\n+changed')).toBe('changed\n')
    expect(
      update('a\nfn x() {\n  target\n}\n', '@@ -2,3 +2,3 @@ fn x() {\n-  target\n+  changed')
    ).toBe('a\nfn x() {\n  changed\n}\n')
    expect(() => update('target\ntarget\n', '@@ -1 +1 @@\n-target\n+changed')).toThrow('ambiguous')
  })
})

describe('canonical patch recovery from common model output', () => {
  it('converts a plain unified diff with file headers', () => {
    const [operation] = parseCanonicalPatch(
      'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new'
    )
    expect(operation).toMatchObject({ type: 'update', path: 'src/a.ts' })
    if (operation.type !== 'update') throw new Error('Expected update')
    expect(applyCanonicalUpdate('keep\nold\n', operation)).toBe('keep\nnew\n')
  })
  it('accepts a Move to header placed after a hunk', () => {
    const [operation] = parseCanonicalPatch(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** Move to: b.txt\n*** End Patch'
    )
    expect(operation).toMatchObject({ type: 'update', path: 'a.txt', movePath: 'b.txt' })
  })
  it('treats bare blank lines inside a hunk as empty context and ignores trailing separators', () => {
    expect(update('a\n\nb\n', '@@\n-a\n+A\n\n b\n')).toBe('A\n\nb\n')
  })
  it('merges separate sections for one file and locates out-of-order hunks', () => {
    const [operation, ...rest] = parseCanonicalPatch(
      '*** Begin Patch\n*** Update File: t.txt\n@@\n-three\n+THREE\n*** Update File: other.txt\n@@\n-x\n+y\n*** Update File: t.txt\n@@\n-one\n+ONE\n*** End Patch'
    )
    expect(rest).toHaveLength(1)
    if (operation.type !== 'update') throw new Error('Expected update')
    expect(applyCanonicalUpdate('one\ntwo\nthree\n', operation)).toBe('ONE\ntwo\nTHREE\n')
  })
  it('matches retyped typography and keeps the file characters in unchanged text', () => {
    const original = 'intro\n| Wildfire | “Area of concern” — confirm via the map. |\nend\n'
    expect(
      update(
        original,
        '@@\n intro\n-| Wildfire | "Area of concern" - confirm via the map. |\n+| Wildfire | "Area of concern" - confirmed outside the zone. |'
      )
    ).toBe('intro\n| Wildfire | “Area of concern” — confirmed outside the zone. |\nend\n')
  })
  it('matches when the model drops an emoji variation selector or trailing spaces', () => {
    expect(update('| ⚠️ Expected low |  \nnext\n', '@@\n-| ⚠ Expected low |\n+| ✅ Low |')).toBe(
      '| ✅ Low |  \nnext\n'
    )
  })
  it('keeps the file quotes and trailing spaces on a changed line', () => {
    expect(update('“a” x  \nnext\n', '@@\n-"a" x\n+"a" y')).toBe('“a” y  \nnext\n')
  })
  it('keeps every unchanged line ending in a mixed CRLF/LF file', () => {
    expect(update('a\nb\r\nc\nd\n', '@@\n a\n-b\n+B\n c')).toBe('a\nB\r\nc\nd\n')
    expect(update('a\nb\nc\r\n', '@@\n-a\n+A')).toBe('A\nb\nc\r\n')
  })
  it('strips read-tool line numbers copied into every hunk line', () => {
    expect(update('one\ntwo\nthree\n', '@@\n 1: one\n-2: two\n+2: TWO')).toBe('one\nTWO\nthree\n')
  })
  it('still rejects tolerant matches that are ambiguous', () => {
    expect(() => update('say “hi”\nsay "hi"\n', "@@\n-say 'hi'\n+bye")).toThrow()
    expect(() => update('say “hi”\nsay "hi"\n', '@@\n-say "hi"\n+bye')).not.toThrow()
  })
  it('shows the closest current lines when context is stale', () => {
    expect(() => update('alpha\nbeta gamma\ndelta\n', '@@\n-beta gama\n+x')).toThrow(
      /2: beta gamma/
    )
  })
})
