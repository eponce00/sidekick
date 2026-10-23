import { describe, expect, it } from 'vitest'
import { fittingOutline, JSON_OUTLINE_STEPS, outlineJson } from './jsonOutline'

/** An editor's state as a page returns it, keys sorted: the token after a long list. */
const editor = {
  editor: {
    actions: Array.from({ length: 120 }, (_, index) => ({ id: `control-${index}`, name: 'Save' })),
    editorToken: 'tok-1',
    guidance: 'Use returned control IDs. '.repeat(40),
    station: { id: 'dsm-lv-1', name: 'DSM LV Assembly 1' }
  },
  ok: true,
  pending: 0
}

describe('outlineJson', () => {
  it('keeps every key and short value, and marks where lists and texts were cut', () => {
    expect(outlineJson(editor, { items: 2, chars: 30, keys: 50 })).toEqual({
      editor: {
        actions: [
          { id: 'control-0', name: 'Save' },
          { id: 'control-1', name: 'Save' },
          '… 118 more items'
        ],
        editorToken: 'tok-1',
        guidance: 'Use returned control IDs. Use … (1,010 more characters)',
        station: { id: 'dsm-lv-1', name: 'DSM LV Assembly 1' }
      },
      ok: true,
      pending: 0
    })
  })

  it('keeps the first keys of an object with very many', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]))
    expect(outlineJson(many, { items: 1, chars: 10, keys: 2 })).toEqual({
      k0: 0,
      k1: 1,
      '…': '28 more keys'
    })
  })
})

describe('fittingOutline', () => {
  it('uses the fullest outline that fits', () => {
    const fitted = fittingOutline(editor, (outline) => JSON.stringify(outline).length < 700)
    expect(fitted?.limits).not.toEqual(JSON_OUTLINE_STEPS[0])
    expect(JSON.stringify(fitted?.outline)).toContain('"editorToken":"tok-1"')
    expect(JSON.stringify(fitted?.outline).length).toBeLessThan(700)
  })

  it('gives nothing for a value that is not an object, or when no outline fits', () => {
    expect(fittingOutline('long text', () => true)).toBeNull()
    expect(fittingOutline(editor, () => false)).toBeNull()
  })
})
