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

describe('auto-scroll positioning', () => {
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
