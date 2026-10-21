// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { followBottom, scrollDistanceFromBottom, type BottomFollower } from './bottomFollow'

/** A scrolling view without layout: a 500px window over content as tall as `height`. */
let view: HTMLDivElement
let line: HTMLParagraphElement
let height = 0
let top = 0
let follower: BottomFollower
let frames: FrameRequestCallback[] = []
let clock = 0
/** A browser reports a scroll in the next frame, before that frame's callbacks run. */
let scrolled = false

function layOut(element: HTMLElement, client: number, content: () => number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: client },
    scrollHeight: { configurable: true, get: content }
  })
}

beforeEach(() => {
  view = document.createElement('div')
  line = document.createElement('p')
  view.append(line)
  document.body.append(view)
  height = 2_000
  top = 1_500
  layOut(view, 500, () => height)
  // Like a browser, the view cannot scroll past either end.
  Object.defineProperty(view, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const next = Math.max(0, Math.min(value, height - 500))
      if (next !== top) scrolled = true
      top = next
    }
  })
  frames = []
  clock = 0
  scrolled = false
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []))
  follower = followBottom(view)
})

afterEach(() => {
  follower.dispose()
  view.remove()
  vi.unstubAllGlobals()
})

/** Runs animation frames as a browser does, 16ms apart, until none are queued. */
function runFrames(limit = 200): number {
  let count = 0
  while (frames.length && count < limit) {
    if (scrolled) {
      scrolled = false
      view.dispatchEvent(new Event('scroll'))
    }
    const pending = frames
    frames = []
    clock += 16
    for (const callback of pending) callback(clock)
    count += 1
  }
  return count
}

/** The reader's own scroll: the input event first, then the scroll it causes. */
function wheel(deltaY: number, target: Element = line, init: WheelEventInit = {}): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, ...init }))
  scrollBy(deltaY)
}

function scrollBy(delta: number): void {
  view.scrollTop = top + delta
  scrolled = false
  view.dispatchEvent(new Event('scroll'))
}

/** A chunk of a streaming reply arrives and the view is asked to keep up. */
function stream(lines = 1): void {
  height += 40 * lines
  follower.keepAtEnd()
  runFrames()
}

describe('following the end of a streaming reply', () => {
  it('lets go at the first small wheel up, and the stream no longer pulls the reader down', () => {
    stream()
    expect(top).toBe(1_540)

    // A touchpad's first tick: far inside the 80px that used to count as "still at the end".
    wheel(-4)
    expect(follower.following).toBe(false)
    expect(top).toBe(1_536)

    for (let chunk = 0; chunk < 10; chunk += 1) stream()
    expect(top).toBe(1_536)
    expect(scrollDistanceFromBottom(view)).toBe(404)
  })

  it('cancels a move to the end already waiting for the next frame', () => {
    height += 40
    follower.keepAtEnd()
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, bubbles: true }))
    runFrames()
    expect(top).toBe(1_500)
  })

  it('stays with the end through its own moves, growth, and content shrinking under it', () => {
    stream(3)
    expect(top).toBe(1_620)

    // A collapsing card shrinks the content; the browser clamps the view upward.
    height -= 200
    view.scrollTop = top
    runFrames()
    expect(top).toBe(1_420)
    expect(follower.following).toBe(true)

    // Something other than the reader moved the view up: not a reason to let go.
    scrollBy(-120)
    expect(follower.following).toBe(true)
    stream()
    expect(scrollDistanceFromBottom(view)).toBe(0)
  })

  it('follows again once the reader scrolls back down near the end', () => {
    wheel(-100)
    wheel(-100)
    wheel(-100)
    expect(follower.following).toBe(false)
    stream()
    expect(scrollDistanceFromBottom(view)).toBe(340)

    // Scrolling up again near the end does not count as returning.
    wheel(100)
    wheel(100)
    expect(follower.following).toBe(false)
    wheel(100)
    expect(scrollDistanceFromBottom(view)).toBe(40)
    expect(follower.following).toBe(true)
    stream()
    expect(scrollDistanceFromBottom(view)).toBe(0)
  })

  it('does not follow again when the view nears the end without the reader', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      wheel(-30)
      vi.advanceTimersByTime(1_000)
      // A row above is measured taller and the view shifts with it, closer to the end for a moment.
      scrollBy(20)
      expect(follower.following).toBe(false)
      // The content below shrinks under the reader.
      height -= 10
      view.scrollTop = top
      runFrames()
      expect(follower.following).toBe(false)

      // The End key, or a held scrollbar, is the reader coming back.
      line.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      scrollBy(10)
      expect(follower.following).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not count a tiny scroll up that stays within the end as returning', () => {
    wheel(-1)
    expect(scrollDistanceFromBottom(view)).toBe(1)
    expect(follower.following).toBe(false)
    stream()
    expect(top).toBe(1_499)
  })

  it('follows again on a wheel down at the very end, which scrolls nothing', () => {
    wheel(-30)
    scrollBy(30)
    // The browser already had the view at the end before this scroll event was handled.
    follower.release()
    view.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true }))
    expect(follower.following).toBe(true)
  })

  it('lets go when the scrollbar, a swipe, or an up key moves the view up', () => {
    view.dispatchEvent(new Event('pointerdown'))
    scrollBy(-200)
    expect(follower.following).toBe(false)
    window.dispatchEvent(new Event('pointerup'))

    follower.follow()
    stream()
    view.dispatchEvent(new Event('touchstart'))
    scrollBy(-60)
    expect(follower.following).toBe(false)
    view.dispatchEvent(Object.assign(new Event('touchend'), { touches: [] }))

    follower.follow()
    stream()
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    scrollBy(-450)
    expect(follower.following).toBe(false)
  })

  it('ignores up keys typed into a text field', () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    scrollBy(-40)
    expect(follower.following).toBe(true)
    field.remove()
  })

  it('leaves the end followed for a pinch, a sideways scroll, or content that fits', () => {
    line.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true }))
    line.dispatchEvent(new WheelEvent('wheel', { deltaX: -40, bubbles: true }))
    expect(follower.following).toBe(true)

    height = 400
    line.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    expect(follower.following).toBe(true)
  })

  it('leaves the end followed while a box inside still scrolls up under the wheel', () => {
    const box = document.createElement('div')
    box.style.overflowY = 'auto'
    const text = document.createElement('span')
    box.append(text)
    view.append(box)
    layOut(box, 100, () => 300)
    box.scrollTop = 50

    text.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }))
    expect(follower.following).toBe(true)

    // At its top, the box hands the wheel on to the view.
    box.scrollTop = 0
    text.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }))
    expect(follower.following).toBe(false)
  })

  it('lets go when the reader selects text with the pointer held', () => {
    line.textContent = 'a streaming answer'
    view.dispatchEvent(new Event('pointerdown'))
    const range = document.createRange()
    range.selectNodeContents(line)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(follower.following).toBe(false)
    document.getSelection()?.removeAllRanges()
  })

  it('reports each change of following and each scroll', () => {
    follower.dispose()
    const onUpdate = vi.fn()
    follower = followBottom(view, { onUpdate })
    wheel(-10)
    expect(onUpdate).toHaveBeenCalledTimes(2)
    follower.follow()
    expect(onUpdate).toHaveBeenCalledTimes(3)
  })
})

describe('moving to the end', () => {
  it('glides over a long way and lands at once over a short or a very long one', () => {
    height += 200
    follower.keepAtEnd({ glide: 'long' })
    runFrames(1)
    expect(top).toBe(1_700)

    height += 600
    follower.keepAtEnd({ glide: 'long' })
    runFrames(1)
    expect(top).toBeGreaterThan(1_700)
    expect(top).toBeLessThan(2_300)
    const frameCount = runFrames()
    expect(frameCount).toBeGreaterThan(5)
    expect(scrollDistanceFromBottom(view)).toBe(0)

    // Further than two screens, a glide would only show rows streaming past.
    height += 5_000
    follower.keepAtEnd({ glide: 'always' })
    runFrames(1)
    expect(scrollDistanceFromBottom(view)).toBe(0)
  })

  it('stops a glide the moment the reader scrolls up', () => {
    height += 800
    follower.keepAtEnd({ glide: 'always' })
    runFrames(2)
    const reached = top
    wheel(-10)
    runFrames()
    expect(top).toBe(reached - 10)
  })

  it('keeps landing on an end that moves while rows below are measured', () => {
    height += 8_000
    follower.keepAtEnd({ settleMs: 1_500 })
    runFrames(1)
    expect(scrollDistanceFromBottom(view)).toBe(0)
    height += 3_000
    runFrames()
    expect(scrollDistanceFromBottom(view)).toBe(0)
  })

  it('waits while a section the reader opened unfolds', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      follower.hold(300)
      height += 200
      follower.keepAtEnd()
      runFrames()
      expect(top).toBe(1_500)

      vi.advanceTimersByTime(400)
      follower.keepAtEnd()
      runFrames()
      expect(top).toBe(1_700)
    } finally {
      vi.useRealTimers()
    }
  })
})
