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
    '*** Begin Patch\n*** Update File: test.txt\n@@\n-before\n+after'
  ])('rejects missing envelope markers before application', (patch) => {
    expect(() => parseCanonicalPatch(patch)).toThrow(
      'Invalid patch: expected *** Begin Patch and *** End Patch sentinels'
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
  it('rejects numbered diff headers with useful guidance', () => {
    expect(() => update('target\n', '@@ -1 +1 @@\n-target\n+changed')).toThrow('bare @@')
  })
})
