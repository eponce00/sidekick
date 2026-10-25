// Custom hook that keeps the chat timeline at its latest message while it grows

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  followBottom,
  RESUME_FOLLOW_PX,
  scrollDistanceFromBottom,
  type BottomFollower
} from '../utils/bottomFollow'
import { SECTION_REVEAL_EVENT } from '../utils/messageMotion'

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

export function shouldShowScrollToBottom(distance: number): boolean {
  return distance > SHOW_JUMP_THRESHOLD
}

/**
 * Keeps the timeline at its latest message while messages arrive and replies stream in, until the
 * reader scrolls up to read; scrolling back to the end, or the jump control, follows it again. How
 * the reader taking over is told apart from the timeline's own moves is in `followBottom`.
 *
 * @param scrollContainerRef - The scrolling timeline
 * @param messages - The messages; a change brings a following timeline to its end
 * @param behavior - 'smooth' glides over a long way instead of jumping
 * @param resetKey - Another chat: open it at its end, following
 * @param changeKey - What changes with the content, when not `messages` itself
 */
export function useAutoScroll<T>(
  scrollContainerRef: RefObject<HTMLElement | null>,
  messages: T[],
  behavior: ScrollBehavior = 'smooth',
  resetKey?: unknown,
  changeKey?: unknown
): AutoScrollController {
  const followerRef = useRef<BottomFollower | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const autoScrollChange = changeKey === undefined ? messages : changeKey

  const updatePosition = useCallback((): void => {
    const container = scrollContainerRef.current
    const follower = followerRef.current
    if (!container || !follower) return
    setShowScrollToBottom(
      !follower.following && shouldShowScrollToBottom(scrollDistanceFromBottom(container))
    )
  }, [scrollContainerRef])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return undefined
    const follower = followBottom(container, { onUpdate: updatePosition })
    followerRef.current = follower
    follower.keepAtEnd()
    return () => {
      follower.dispose()
      if (followerRef.current === follower) followerRef.current = null
    }
  }, [resetKey, scrollContainerRef, updatePosition])

  /**
   * Jumps to the latest message. A long timeline is virtualized: rows below the view have only
   * estimated heights until they are measured on the way down, so the end moves while the jump
   * runs. Keep landing on the end until it stops moving, unless the reader scrolls themselves.
   */
  const scrollToBottom = useCallback((): void => {
    setShowScrollToBottom(false)
    const follower = followerRef.current
    if (!follower) return
    follower.follow()
    follower.keepAtEnd({ glide: 'always', settleMs: JUMP_SETTLE_MS })
  }, [])

  const revealStart = useCallback(
    (element: HTMLElement, options: { onlyIfFollowing?: boolean } = {}): void => {
      const container = scrollContainerRef.current
      const follower = followerRef.current
      if (!container || !follower) return
      const offset =
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - REVEAL_MARGIN
      // A follower who can already see where the answer starts stays at the end.
      if (options.onlyIfFollowing && (!follower.following || offset >= 0)) return
      const bottom = Math.max(0, container.scrollHeight - container.clientHeight)
      const target = Math.max(0, Math.min(container.scrollTop + offset, bottom))
      if (bottom - target <= RESUME_FOLLOW_PX) follower.follow()
      else follower.release()
      container.scrollTop = target
      updatePosition()
    },
    [scrollContainerRef, updatePosition]
  )

  // A chat's first messages, as its history loads, land at once; later ones may glide.
  const shownRef = useRef({ resetKey, any: false })
  const messageCount = messages.length
  useEffect(() => {
    if (shownRef.current.resetKey !== resetKey) shownRef.current = { resetKey, any: false }
    const glide = behavior === 'smooth' && shownRef.current.any
    shownRef.current.any = messageCount > 0
    // A streaming reply grows a few lines at a time. Gliding each of them makes the view lurch,
    // so small growth follows at once and only a bigger jump glides. Away from the end, the
    // observers below update the jump control as the content changes.
    followerRef.current?.keepAtEnd({ glide: glide ? 'long' : 'never' })
  }, [autoScrollChange, behavior, messageCount, resetKey])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || typeof window.ResizeObserver !== 'function') return

    const observedChildren = new Set<Element>()
    const followSettledLayout = (immediate = false): void => {
      const follower = followerRef.current
      if (follower?.following) follower.keepAtEnd({ immediate })
      else updatePosition()
    }
    // Layout is already done when a resize observer runs, so growth lands before paint.
    const resizeObserver = new window.ResizeObserver(() => followSettledLayout(true))
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

    // Opening a section unfolds it from where it was clicked, even at the end of the chat; once
    // it settles, following goes on only if the end is still in view.
    let settle: ReturnType<typeof setTimeout> | null = null
    const holdForReveal = (event: Event): void => {
      const ms = (event as CustomEvent<{ ms?: number }>).detail?.ms ?? 0
      followerRef.current?.hold(ms + 60)
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        const follower = followerRef.current
        if (follower?.following && scrollDistanceFromBottom(container) > RESUME_FOLLOW_PX) {
          follower.release()
        }
        updatePosition()
      }, ms + 80)
    }
    container.addEventListener(SECTION_REVEAL_EVENT, holdForReveal)

    return () => {
      if (settle) clearTimeout(settle)
      container.removeEventListener(SECTION_REVEAL_EVENT, holdForReveal)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
    }
  }, [resetKey, scrollContainerRef, updatePosition])

  return { showScrollToBottom, scrollToBottom, revealStart }
}
