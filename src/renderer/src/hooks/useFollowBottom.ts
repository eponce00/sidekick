import { useEffect, useRef } from 'react'
import { followBottom } from '../utils/bottomFollow'

/**
 * Keeps a scrolling box at its end while its content grows, as text streams into it, unless the
 * reader scrolled up to read; scrolling back to the end follows again.
 */
export function useFollowBottom<T extends HTMLElement>(
  enabled: boolean,
  resumeWithin?: number
): React.RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return undefined
    const follower = followBottom(element, { resumeWithin })
    const follow = (): void => {
      if (follower.following) element.scrollTop = element.scrollHeight
    }
    follow()
    const observer = new MutationObserver(follow)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      follower.dispose()
    }
  }, [enabled, resumeWithin])

  return ref
}
