import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { OVERLAY_PAGE, overlayInput } from './browserAnnotationOverlay'

describe('the annotation overlay', () => {
  it("draws the page's labels as text, never as markup", () => {
    const dom = new JSDOM(OVERLAY_PAGE, { runScripts: 'dangerously' })
    const window = dom.window as unknown as Window & { render: (state: unknown) => void }
    window.render({
      accent: '#2850b8',
      accentText: '#ffffff',
      hover: {
        x: 10,
        y: 4,
        width: 80,
        height: 20,
        label: '<img src=x onerror="document.title=1">'
      },
      marks: [{ x: 5, y: 30, width: 40, height: 10, number: 1, area: true }]
    })
    const document = window.document
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('.label')?.textContent).toBe(
      '<img src=x onerror="document.title=1">'
    )
    // Too near the top for a label above the box, so it goes below.
    expect(document.querySelector('.label')?.className).toBe('label below')
    expect(document.querySelector('.mark.area .badge')?.textContent).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2850b8')
    window.render({ accent: '#2850b8', accentText: '#ffffff', marks: [] })
    expect(document.body.children).toHaveLength(0)
    dom.window.close()
  })

  it("reads only the left button's clicks and drags, the pointer, and the wheel", () => {
    expect(
      overlayInput({ type: 'mouseDown', button: 'left', x: 3, y: 4, modifiers: ['leftbuttondown'] })
    ).toEqual({ type: 'down', x: 3, y: 4 })
    expect(overlayInput({ type: 'mouseDown', button: 'right', x: 3, y: 4 })).toBeUndefined()
    expect(overlayInput({ type: 'mouseMove', x: 5, y: 6 })).toEqual({
      type: 'move',
      x: 5,
      y: 6
    })
    expect(overlayInput({ type: 'mouseWheel', x: 1, y: 2, deltaY: -120 } as never)).toEqual({
      type: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: -120
    })
    expect(overlayInput({ type: 'contextMenu', x: 1, y: 2 })).toBeUndefined()
  })
})
