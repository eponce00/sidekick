import { describe, expect, it } from 'vitest'
import { parseAnnotationOverlayMessage } from '../../shared/annotationOverlay'

describe('messages from the annotation overlay', () => {
  it('accepts what the overlay sends and nothing else', () => {
    expect(parseAnnotationOverlayMessage({ type: 'pointer', kind: 'down', x: 4, y: 8 })).toEqual({
      type: 'pointer',
      kind: 'down',
      x: 4,
      y: 8
    })
    expect(parseAnnotationOverlayMessage({ type: 'note', id: 'm1', note: 'Bigger' })).toEqual({
      type: 'note',
      id: 'm1',
      note: 'Bigger'
    })
    expect(
      parseAnnotationOverlayMessage({
        type: 'style',
        id: 'm1',
        styles: { color: 'rgb(255, 0, 0)', 'font-family': "'Times New Roman', serif" }
      })
    ).toEqual({
      type: 'style',
      id: 'm1',
      styles: { color: 'rgb(255, 0, 0)', 'font-family': "'Times New Roman', serif" }
    })
    for (const bad of [
      null,
      'send',
      { type: 'eval', code: 'x' },
      { type: 'pointer', kind: 'down', x: Number.NaN, y: 1 },
      { type: 'pointer', kind: 'click', x: 1, y: 1 },
      { type: 'note', id: 'm1', note: 'x'.repeat(5_000) },
      { type: 'remove', id: { toString: () => 'm1' } },
      { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 1e9 },
      // A style value never ends its declaration, adds another, or loads anything.
      { type: 'style', id: 'm1', styles: { color: 'red; position: fixed' } },
      { type: 'style', id: 'm1', styles: { 'background-color': 'url(https://x.test/a.png)' } },
      { type: 'style', id: 'm1', styles: { color: 'red } body { display: none' } },
      { type: 'style', id: 'm1', styles: { opacity: 1 } },
      { type: 'dictate', on: 'yes' }
    ])
      expect(parseAnnotationOverlayMessage(bad), JSON.stringify(bad)).toBeNull()
  })
})
