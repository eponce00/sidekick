// Custom hook for auto-scrolling to bottom of messages

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const FOLLOW_BOTTOM_THRESHOLD = 80
const SHOW_JUMP_THRESHOLD = 240

export interface AutoScrollController {
  showScrollToBottom: boolean
  scrollToBottom: () => void
  /**
   * Brings the start of `element` to the top of the view, as far as the end of
   * the timeline allows. With `onlyIfFollowing`, it acts only for a reader
   * following the bottom who can no longer see where the element starts.
   */
  revealStart: (element: HTMLElement, options?: { onlyIfFollowing?: boolean }) => void
}

const REVEAL_MARGIN = 12
/** How long a jump to the latest message keeps correcting for rows measured on the way. */
const JUMP_SETTLE_MS = 1_500

export function scrollDistanceFromBottom(
  container: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>
): number {
  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight)
}

export function shouldShowScrollToBottom(distance: number): boolean {
  return distance > SHOW_JUMP_THRESHOLD
}

/**
 * Hook that automatically scrolls to the bottom when messages change
 * Useful for chat interfaces to show the latest message
 *
 * @param messagesEndRef - Ref to an element at the bottom of the messages list
 * @param scrollContainerRef - Ref to the scrollable messages container
 * @param messages - Array of messages (triggers scroll when it changes)
 * @param behavior - Scroll behavior: 'smooth' or 'auto' (default: 'smooth')
 *
 * @example
 * const messagesEndRef = useRef<HTMLDivElement>(null)
 * const messagesContainerRef = useRef<HTMLDivElement>(null)
 * useAutoScroll(messagesEndRef, messagesContainerRef, messages)
 *
 * // In JSX:
 * <div ref={messagesEndRef} />
 */
export function useAutoScroll<T>(
  messagesEndRef: RefObject<HTMLElement | null>,
  scrollContainerRef: RefObject<HTMLElement | null>,
  messages: T[],
  behavior: ScrollBehavior = 'smooth',
  resetKey?: unknown,
  changeKey?: unknown
): AutoScrollController {
  const shouldStickToBottomRef = useRef(true)
  /** A jump to the latest message is under way; its own scroll events are not the reader's. */
  const jumpingRef = useRef(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const autoScrollChange = changeKey === undefined ? messages : changeKey

  const moveToBottom = useCallback(
    (scrollBehavior: ScrollBehavior): void => {
      const container = scrollContainerRef.current
      if (container && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior: scrollBehavior })
        return
      }
      messagesEndRef.current?.scrollIntoView({ behavior: scrollBehavior, block: 'nearest' })
    },
    [messagesEndRef, scrollContainerRef]
  )

  const updatePosition = useCallback((): void => {
    const container = scrollContainerRef.current
    if (!container || jumpingRef.current) return
    const distance = scrollDistanceFromBottom(container)
    shouldStickToBottomRef.current = distance <= FOLLOW_BOTTOM_THRESHOLD
    setShowScrollToBottom(shouldShowScrollToBottom(distance))
  }, [scrollContainerRef])

  /**
   * Jumps to the latest message. A long timeline is virtualized: rows below the view have only
   * estimated heights until they are measured on the way down, so the end moves while the jump
   * runs. Keep landing on the end until it stops moving, unless the reader scrolls themselves.
   */
  const scrollToBottom = useCallback((): void => {
    shouldStickToBottomRef.current = true
    setShowScrollToBottom(false)
    const container = scrollContainerRef.current
    if (!container || typeof container.scrollTo !== 'function') {
      moveToBottom('smooth')
      return
    }
    // Far away, an animated scroll only shows rows streaming past; land at once.
    const far = scrollDistanceFromBottom(container) > container.clientHeight * 2
    moveToBottom(far ? 'auto' : 'smooth')
    jumpingRef.current = true
    const startedAt = Date.now()
    let settledFrames = 0
    const stop = (): void => {
      jumpingRef.current = false
      container.removeEventListener('wheel', stop)
      container.removeEventListener('touchstart', stop)
      container.removeEventListener('keydown', stop)
      updatePosition()
    }
    // The reader taking over ends the jump where they are.
    container.addEventListener('wheel', stop, { passive: true })
    container.addEventListener('touchstart', stop, { passive: true })
    container.addEventListener('keydown', stop)
    const settle = (): void => {
      if (!jumpingRef.current) return
      const elapsed = Date.now() - startedAt
      if (scrollDistanceFromBottom(container) <= 2) settledFrames += 1
      else {
        settledFrames = 0
        // A smooth scroll gets its moment; then, or for a far jump, snap to the new end.
        if (far || elapsed > 400)
          container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
      }
      if (settledFrames >= 3 || elapsed > JUMP_SETTLE_MS) stop()
      else window.requestAnimationFrame(settle)
    }
    window.requestAnimationFrame(settle)
  }, [moveToBottom, scrollContainerRef, updatePosition])

  const revealStart = useCallback(
    (element: HTMLElement, options: { onlyIfFollowing?: boolean } = {}): void => {
      const container = scrollContainerRef.current
      if (!container || typeof container.scrollTo !== 'function') return
      const offset =
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - REVEAL_MARGIN
      // A follower who can already see where the answer starts stays at the end.
      if (options.onlyIfFollowing && (!shouldStickToBottomRef.current || offset >= 0)) return
      const bottom = Math.max(0, container.scrollHeight - container.clientHeight)
      const target = Math.max(0, Math.min(container.scrollTop + offset, bottom))
      shouldStickToBottomRef.current = bottom - target <= FOLLOW_BOTTOM_THRESHOLD
      setShowScrollToBottom(shouldShowScrollToBottom(bottom - target))
      // Instant: the scroll events of a smooth scroll start near the bottom and
      // would resume following it.
      container.scrollTo({ top: target, behavior: 'auto' })
    },
    [scrollContainerRef]
  )

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    updatePosition()
    container.addEventListener('scroll', updatePosition, { passive: true })

    return () => {
      container.removeEventListener('scroll', updatePosition)
    }
  }, [resetKey, scrollContainerRef, updatePosition])

  useEffect(() => {
    shouldStickToBottomRef.current = true
    const frame = window.requestAnimationFrame(() => {
      setShowScrollToBottom(false)
      moveToBottom('auto')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [moveToBottom, resetKey])

  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      const frame = window.requestAnimationFrame(() => {
        setShowScrollToBottom(false)
        moveToBottom(behavior)
      })
      return () => window.cancelAnimationFrame(frame)
    }
    updatePosition()
    return undefined
  }, [autoScrollChange, behavior, moveToBottom, updatePosition])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || typeof window.ResizeObserver !== 'function') return

    let frame: number | null = null
    const observedChildren = new Set<Element>()
    const followSettledLayout = (): void => {
      if (!shouldStickToBottomRef.current) {
        updatePosition()
        return
      }
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        setShowScrollToBottom(false)
        moveToBottom('auto')
      })
    }
    const resizeObserver = new window.ResizeObserver(followSettledLayout)
    const observeTimelineChildren = (): void => {
      for (const child of Array.from(container.children)) {
        if (observedChildren.has(child)) continue
        observedChildren.add(child)
        resizeObserver.observe(child)
      }
    }
    observeTimelineChildren()

    const mutationObserver = new MutationObserver(() => {
      observeTimelineChildren()
      followSettledLayout()
    })
    mutationObserver.observe(container, { childList: true, subtree: true })

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [moveToBottom, resetKey, scrollContainerRef, updatePosition])

  return { showScrollToBottom, scrollToBottom, revealStart }
}
