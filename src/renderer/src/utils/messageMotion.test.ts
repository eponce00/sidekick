// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dissolveMessages } from './messageMotion'

function messageAt(top: number, height = 100): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect
  return element
}

describe('dissolveMessages', () => {
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate
  })

  it('fades the messages in view and hides the rest, resolving when they are gone', async () => {
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const animate = vi.fn(() => ({ finished }) as unknown as Animation)
    Element.prototype.animate = animate
    const viewport = { top: 0, bottom: 500 } as DOMRect
    const inView = messageAt(300)
    const below = messageAt(900)

    let done = false
    const leaving = dissolveMessages([inView, below], viewport).then(() => (done = true))

    expect(animate).toHaveBeenCalledTimes(1)
    expect(below.style.visibility).toBe('hidden')
    await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await leaving
    expect(done).toBe(true)
  })

  it('moves on when the window stops the animation partway', async () => {
    vi.useFakeTimers()
    try {
      Element.prototype.animate = vi.fn(
        () => ({ finished: new Promise<void>(() => undefined) }) as unknown as Animation
      )
      const leaving = dissolveMessages([messageAt(0)], { top: 0, bottom: 500 } as DOMRect)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(leaving).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not animate in a hidden window', async () => {
    const animate = vi.fn()
    Element.prototype.animate = animate
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await dissolveMessages([messageAt(0)], null)
      expect(animate).not.toHaveBeenCalled()
    } finally {
      visibility.mockRestore()
    }
  })

  it('resolves at once with nothing to animate', async () => {
    await expect(dissolveMessages([], null)).resolves.toBeUndefined()
  })
})
