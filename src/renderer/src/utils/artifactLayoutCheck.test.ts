// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { findArtifactLayoutProblems } from './artifactLayoutCheck'

describe('canvas proportions in artifact inspection', () => {
  afterEach(() => document.body.replaceChildren())

  function canvas(width: number, height: number): HTMLCanvasElement {
    const element = document.createElement('canvas')
    element.width = 420
    element.height = 600
    Object.defineProperties(element, {
      clientWidth: { value: width },
      clientHeight: { value: height }
    })
    Object.defineProperty(document.body, 'innerText', { value: '', configurable: true })
    document.body.appendChild(element)
    return element
  }

  it('reports the vertical squash caused by a height cap on a responsive game canvas', () => {
    canvas(420, 300)
    expect(findArtifactLayoutProblems(document)).toEqual([
      expect.stringContaining('A canvas is stretched or squashed')
    ])
  })

  it('accepts uniform downscaling and high-DPI drawing buffers', () => {
    const element = canvas(210, 300)
    element.width = 840
    element.height = 1200
    expect(findArtifactLayoutProblems(document)).toEqual([])
  })

  it('ignores rounding differences and invisible canvases', () => {
    canvas(210, 299)
    canvas(0, 0)
    expect(findArtifactLayoutProblems(document)).toEqual([])
  })

  it('accepts a letterboxed canvas whose bitmap keeps its ratio inside the box', () => {
    const element = canvas(420, 300)
    element.style.objectFit = 'contain'
    expect(findArtifactLayoutProblems(document)).toEqual([])
  })

  it('measures the drawing area without padding', () => {
    const element = canvas(440, 620)
    element.style.padding = '10px'
    expect(findArtifactLayoutProblems(document)).toEqual([])
  })
})
