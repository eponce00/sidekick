// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SidekickPeek } from './SidekickPeek'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('SidekickPeek', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('draws the app icon robot with parts the theme colours and the eyes that blink', async () => {
    await act(async () => root.render(<SidekickPeek />))
    const peek = container.querySelector('.sidekick-peek')!
    // Decoration only: screen readers skip it.
    expect(peek.getAttribute('aria-hidden')).toBe('true')
    expect(peek.querySelectorAll('.peek-eye')).toHaveLength(2)
    for (const part of ['helmet', 'visor', 'led', 'glint', 'shade']) {
      expect(peek.querySelector(`.peek-${part}`), part).not.toBeNull()
    }
    // Its right side is cut straight, so it leans out from behind an edge.
    expect(peek.querySelector('clipPath path')?.getAttribute('d')).toMatch(/^M0 0 H\d+ V1024 H0 Z$/)
  })

  it('winks when poked, and squints happily every third time', async () => {
    await act(async () => root.render(<SidekickPeek />))
    const peek = container.querySelector<HTMLButtonElement>('.sidekick-peek')!
    const poke = async (): Promise<void> => {
      await act(async () => peek.click())
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
    await poke()
    expect(peek.classList.contains('is-wink')).toBe(true)
    await poke()
    await poke()
    expect(peek.classList.contains('is-happy')).toBe(true)
  })
})
