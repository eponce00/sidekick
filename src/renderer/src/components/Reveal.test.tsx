// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Reveal } from './Reveal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('Reveal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    delete (Element.prototype as Partial<Element>).animate
  })

  const render = (open: boolean): Promise<void> =>
    act(async () =>
      root.render(
        <Reveal open={open}>
          <p>Details</p>
        </Reveal>
      )
    )

  it('shows and hides at once where nothing can animate', async () => {
    await render(false)
    expect(container.textContent).toBe('')
    await render(true)
    expect(container.textContent).toBe('Details')
    await render(false)
    expect(container.textContent).toBe('')
  })

  it('slides open from nothing and stays until it has slid shut', async () => {
    const animations: Array<{ keyframes: Keyframe[]; animation: { onfinish?: () => void } }> = []
    Element.prototype.animate = vi.fn(function (keyframes: Keyframe[]) {
      const animation = { cancel: vi.fn() } as { cancel: () => void; onfinish?: () => void }
      animations.push({ keyframes, animation })
      return animation as unknown as Animation
    })

    await render(false)
    await render(true)
    expect(animations[0].keyframes[0].height).toBe('0px')
    expect(animations[0].keyframes[1].opacity).toBe(1)

    await render(false)
    expect(animations[1].keyframes[1].height).toBe('0px')
    expect(container.textContent).toBe('Details')

    await act(async () => animations[1].animation.onfinish?.())
    expect(container.textContent).toBe('')
  })

  it('does not animate content that starts open', async () => {
    Element.prototype.animate = vi.fn()
    await render(true)
    expect(container.textContent).toBe('Details')
    expect(Element.prototype.animate).not.toHaveBeenCalled()
  })
})
