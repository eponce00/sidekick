// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  scrollDistanceFromBottom,
  shouldShowScrollToBottom,
  useAutoScroll,
  type AutoScrollController
} from './useAutoScroll'

let root: Root
let host: HTMLDivElement
let controller: AutoScrollController
let resizeCallback: ResizeObserverCallback | null

function Harness({ ready }: { ready: boolean }): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const value = useAutoScroll(endRef, containerRef, [], 'smooth', ready ? 'ready' : 'loading')
  useEffect(() => {
    controller = value
  }, [value])
  if (!ready) return null
  return (
    <div ref={containerRef}>
      <div ref={endRef} />
    </div>
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  resizeCallback = null
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
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

/** Runs animation frames one at a time, as a browser does, instead of at once. */
let frames: FrameRequestCallback[] = []
function queueFrames(): void {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
}
function runFrame(): void {
  const pending = frames
  frames = []
  for (const callback of pending) callback(0)
}

describe('auto-scroll positioning', () => {
  it('lands on the latest message even when the timeline grows during the jump', async () => {
    // A long chat is virtualized: rows below have estimated heights until measured on the way
    // down, so a scroll to the old end stopped a big chunk short of the latest message.
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    let height = 20_000
    let top = 2_000
    const scrollTo = vi.fn(({ top: target }: { top: number }) => {
      top = Math.min(target, height - 500)
    })
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = value) },
      scrollTo: { configurable: true, value: scrollTo }
    })

    queueFrames()
    act(() => controller.scrollToBottom())
    // Far away: an instant jump, not an animation through thousands of rows.
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 20_000, behavior: 'auto' })

    // Rows measured on arrival make the timeline taller; the jump follows the new end.
    height = 26_000
    act(() => timeline.dispatchEvent(new Event('scroll')))
    act(() => runFrame())
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 26_000, behavior: 'auto' })
    expect(scrollDistanceFromBottom(timeline)).toBe(0)
    for (let frame = 0; frame < 4; frame += 1) act(() => runFrame())
    expect(controller.showScrollToBottom).toBe(false)
  })

  it('stops a jump when the reader scrolls themselves', async () => {
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    const height = 20_000
    let top = 2_000
    const scrollTo = vi.fn()
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = value) },
      scrollTo: { configurable: true, value: scrollTo }
    })
    queueFrames()
    act(() => controller.scrollToBottom())
    scrollTo.mockClear()
    act(() => timeline.dispatchEvent(new Event('wheel')))
    top = 5_000
    act(() => runFrame())
    expect(scrollTo).not.toHaveBeenCalled()
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
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1_400 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollTo: { configurable: true, value: vi.fn() }
    })

    act(() => timeline.dispatchEvent(new Event('scroll')))
    expect(controller.showScrollToBottom).toBe(true)

    queueFrames()
    act(() => controller.scrollToBottom())
    expect(controller.showScrollToBottom).toBe(false)
    expect(timeline.scrollTo).toHaveBeenCalledWith({ top: 1_400, behavior: 'smooth' })
  })

  it('keeps following content whose layout grows after the transcript renders', async () => {
    await act(async () => root.render(<Harness ready />))
    const timeline = host.firstElementChild as HTMLDivElement
    const scrollTo = vi.fn()
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1_800 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 1_300 },
      scrollTo: { configurable: true, value: scrollTo }
    })

    act(() => resizeCallback?.([], {} as ResizeObserver))

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_800, behavior: 'auto' })
  })
})
