// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import peekSvg from '../assets/sidekick-peek.svg?raw'
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
    vi.unstubAllGlobals()
  })

  const frames = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
  }
  const capeOutline = (): string => container.querySelector('.peek-cape')?.getAttribute('d') ?? ''

  it('moves its cape as cloth, redrawing it every frame, and keeps it through a click', async () => {
    await act(async () => root.render(<SidekickPeek />))
    const drawn = capeOutline()
    const cape = container.querySelector('.peek-cape')
    await frames(2)
    const moving = capeOutline()
    expect(moving).not.toBe(drawn)
    await act(async () => container.querySelector<HTMLButtonElement>('.sidekick-peek')!.click())
    await frames(4)
    expect(capeOutline()).not.toBe(moving)
    expect(capeOutline()).not.toMatch(/NaN/)
    // Its reaction re-renders the button without redrawing the robot, so the cloth stays put.
    expect(container.querySelector('.peek-cape')).toBe(cape)
  })

  it('leaves the cape as drawn when motion is reduced', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    await act(async () => root.render(<SidekickPeek />))
    await frames(3)
    const drawn = new DOMParser()
      .parseFromString(peekSvg, 'image/svg+xml')
      .querySelector('.peek-cape')
      ?.getAttribute('d')
    expect(capeOutline()).toBe(drawn)
  })

  it('still moves its cape when it appears while the window is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => root.render(<SidekickPeek />))
    const drawn = capeOutline()
    visibility.mockReturnValue('visible')
    await frames(2)
    expect(capeOutline()).not.toBe(drawn)
    visibility.mockRestore()
  })
})
