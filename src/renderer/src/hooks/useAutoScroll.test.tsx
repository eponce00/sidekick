// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldShowScrollToBottom, useAutoScroll, type AutoScrollController } from './useAutoScroll'
import { scrollDistanceFromBottom } from '../utils/bottomFollow'
import { SECTION_REVEAL_EVENT } from '../utils/messageMotion'

let root: Root
let host: HTMLDivElement
let controller: AutoScrollController
let resizeCallback: ResizeObserverCallback | null

function Harness({ ready }: { ready: boolean }): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const value = useAutoScroll(containerRef, [], 'smooth', ready ? 'ready' : 'loading')
  useEffect(() => {
    controller = value
  }, [value])
  if (!ready) return null
  return <div ref={containerRef} />
}

/** A timeline without layout: a `client` px window over `height()` px, clamped like a browser. */
function layOut(
  timeline: HTMLElement,
  options: { height: () => number; client: number; top: number }
): { top: () => number } {
  let top = options.top
  Object.defineProperties(timeline, {
    scrollHeight: { configurable: true, get: options.height },
    clientHeight: { configurable: true, value: options.client },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) =>
        (top = Math.max(0, Math.min(value, options.height() - options.client)))
    }
  })
  return { top: () => top }
}

/** The reader's wheel, then the scroll it causes. */
function wheel(timeline: HTMLElement, deltaY: number): void {
  act(() => {
    timeline.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
    timeline.scrollTop += deltaY
    timeline.dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  resizeCallback = null
  queueFrames()
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe(target: Element): void {
        void target
      }
      disconnect(): void {
        void resizeCallback
      }
      unobserve(target: Element): void {
        void target
      }
    }
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** Runs animation frames one at a time, 16ms apart, as a browser does. */
let frames: FrameRequestCallback[] = []
let clock = 0
function queueFrames(): void {
  frames = []
  clock = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []))
}
function runFrame(): void {
  const pending = frames
  frames = []
  clock += 16
  for (const callback of pending) callback(clock)
}
function runFrames(): void {
  for (let count = 0; frames.length && count < 200; count += 1) act(() => runFrame())
}

describe('auto-scroll positioning', () => {
  it('lands on the latest message even when the timeline grows during the jump', async () => {
    // A long chat is virtualized: rows below have estimated heights until measured on the way
    // down, so a scroll to the old end stopped a big chunk short of the latest message.
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    let height = 20_000
    const view = layOut(timeline, { height: () => height, client: 500, top: 2_000 })
    runFrames()
    wheel(timeline, -2_000)
    expect(controller.showScrollToBottom).toBe(true)

    act(() => controller.scrollToBottom())
    // Far away: an instant jump, not an animation through thousands of rows.
    act(() => runFrame())
    expect(view.top()).toBe(19_500)

    // Rows measured on arrival make the timeline taller; the jump follows the new end.
    height = 26_000
    act(() => runFrame())
    expect(view.top()).toBe(25_500)
    expect(scrollDistanceFromBottom(timeline)).toBe(0)
    runFrames()
    expect(controller.showScrollToBottom).toBe(false)
  })

  it('stops a jump when the reader scrolls back up', async () => {
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    let height = 20_000
    const view = layOut(timeline, { height: () => height, client: 500, top: 19_500 })
    act(() => controller.scrollToBottom())
    act(() => runFrame())
    height = 26_000
    wheel(timeline, -300)
    runFrames()
    expect(view.top()).toBe(19_200)
  })

  it('calculates a bounded distance from the latest message', () => {
    expect(
      scrollDistanceFromBottom({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 500 })
    ).toBe(100)
    expect(scrollDistanceFromBottom({ scrollHeight: 500, scrollTop: 20, clientHeight: 600 })).toBe(
      0
    )
  })

  it('only offers the jump control when the user is meaningfully scrolled away', () => {
    expect(shouldShowScrollToBottom(240)).toBe(false)
    expect(shouldShowScrollToBottom(241)).toBe(true)
  })

  it('attaches after an asynchronously rendered timeline and clears after jumping', async () => {
    await act(async () => root.render(<Harness ready={false} />))
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    const view = layOut(timeline, { height: () => 1_400, client: 500, top: 900 })
    runFrames()

    wheel(timeline, -800)
    expect(controller.showScrollToBottom).toBe(true)

    act(() => controller.scrollToBottom())
    expect(controller.showScrollToBottom).toBe(false)
    // Close by, the jump glides there instead of landing at once.
    act(() => runFrame())
    expect(view.top()).toBeGreaterThan(100)
    expect(view.top()).toBeLessThan(900)
    runFrames()
    expect(view.top()).toBe(900)
  })

  it('keeps following content whose layout grows after the transcript renders', async () => {
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    const view = layOut(timeline, { height: () => 1_800, client: 500, top: 1_000 })

    act(() => resizeCallback?.([], {} as ResizeObserver))
    runFrames()

    expect(view.top()).toBe(1_300)
  })

  it('lets a section the reader opens unfold from where it was, even at the end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await act(async () => root.render(<Harness ready />))
      const timeline = host.firstElementChild as HTMLDivElement
      let height = 1_800
      const view = layOut(timeline, { height: () => height, client: 500, top: 1_300 })
      runFrames()

      timeline.dispatchEvent(
        new CustomEvent(SECTION_REVEAL_EVENT, { bubbles: true, detail: { ms: 260 } })
      )
      // The section grows below the end while it opens.
      height = 2_100
      act(() => resizeCallback?.([], {} as ResizeObserver))
      runFrames()
      expect(view.top()).toBe(1_300)

      // Settled, the end is out of view, so the chat no longer follows it.
      await act(async () => vi.advanceTimersByTimeAsync(400))
      act(() => resizeCallback?.([], {} as ResizeObserver))
      runFrames()
      expect(view.top()).toBe(1_300)
      expect(controller.showScrollToBottom).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

function Following({ messages, chat }: { messages: string[]; chat: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const value = useAutoScroll(containerRef, messages, 'smooth', chat)
  useEffect(() => {
    controller = value
  }, [value])
  return <div ref={containerRef} data-testid="follow" />
}

describe('following a growing reply', () => {
  let container: HTMLDivElement
  let height: number
  let view: { top: () => number }
  let chat: string

  async function open(messages: string[], next: string): Promise<void> {
    chat = next
    await act(async () => root.render(<Following messages={messages} chat={chat} />))
  }

  async function render(messages: string[], grownTo: number): Promise<void> {
    height = grownTo
    await act(async () => root.render(<Following messages={messages} chat={chat} />))
  }

  beforeEach(async () => {
    await open(['a'], 'chat')
    container = host.querySelector<HTMLDivElement>('[data-testid="follow"]')!
    height = 1_000
    view = layOut(container, { height: () => height, client: 400, top: 600 })
    runFrames()
  })

  it('follows a few new lines at once and glides only over a bigger jump', async () => {
    await render(['a', 'b'], 1_060)
    act(() => runFrame())
    expect(view.top()).toBe(660)

    runFrames()
    await render(['a', 'b', 'c'], 1_600)
    act(() => runFrame())
    expect(view.top()).toBeGreaterThan(660)
    expect(view.top()).toBeLessThan(1_200)
    runFrames()
    expect(view.top()).toBe(1_200)
  })

  it('lands at once on a chat whose history has just loaded', async () => {
    await open([], 'other')
    runFrames()
    await render(['a', 'b', 'c'], 1_600)
    act(() => runFrame())
    expect(view.top()).toBe(1_200)
  })

  it('leaves a reader who scrolled up a little where they are while the reply streams', async () => {
    // Reported: scrolling up during a reply fought back, pulling the view down with every chunk
    // until one big scroll got past "near the end".
    await render(['a', 'b'], 1_040)
    runFrames()
    expect(view.top()).toBe(640)

    wheel(container, -4)
    for (let chunk = 1; chunk <= 12; chunk += 1) {
      await render(['a', 'b'], 1_040 + chunk * 30)
      act(() => resizeCallback?.([], {} as ResizeObserver))
      runFrames()
      expect(view.top()).toBe(636)
    }
    expect(controller.showScrollToBottom).toBe(true)

    // The jump control, or scrolling back down to the end, follows the reply again.
    act(() => controller.scrollToBottom())
    runFrames()
    expect(scrollDistanceFromBottom(container)).toBe(0)
    await render(['a', 'b', 'c'], 1_500)
    runFrames()
    expect(scrollDistanceFromBottom(container)).toBe(0)
  })

  it('opens another chat at its end, following again', async () => {
    wheel(container, -300)
    await render(['a', 'b'], 1_200)
    runFrames()
    expect(view.top()).toBe(300)

    await open(['x'], 'other')
    runFrames()
    expect(scrollDistanceFromBottom(container)).toBe(0)
    await render(['x', 'y'], 1_400)
    runFrames()
    expect(scrollDistanceFromBottom(container)).toBe(0)
  })
})
