import { useEffect, useRef } from 'react'

/**
 * Keeps a scrolling box at its end while its content grows, as text streams into it, unless the
 * reader scrolled up to read; scrolling back to the end follows again.
 */
export function useFollowBottom<T extends HTMLElement>(
  enabled: boolean
): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return undefined
    const onScroll = (): void => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
    }
    const follow = (): void => {
      if (pinned.current) element.scrollTop = element.scrollHeight
    }
    pinned.current = true
    follow()
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = new MutationObserver(follow)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [enabled])

  return ref
}
