// Custom hook for auto-scrolling to bottom of messages

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const FOLLOW_BOTTOM_THRESHOLD = 80
const SHOW_JUMP_THRESHOLD = 240

export interface AutoScrollController {
  showScrollToBottom: boolean
  scrollToBottom: () => void
}

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
    if (!container) return
    const distance = scrollDistanceFromBottom(container)
    shouldStickToBottomRef.current = distance <= FOLLOW_BOTTOM_THRESHOLD
    setShowScrollToBottom(shouldShowScrollToBottom(distance))
  }, [scrollContainerRef])

  const scrollToBottom = useCallback((): void => {
    shouldStickToBottomRef.current = true
    setShowScrollToBottom(false)
    moveToBottom('smooth')
  }, [moveToBottom])

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

  return { showScrollToBottom, scrollToBottom }
}
