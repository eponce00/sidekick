import { useEffect, useRef, type RefObject } from 'react'

/** How far a panel must be dragged toward its edge, in pixels, to close when let go. */
export const SWIPE_CLOSE_DISTANCE = 72

/**
 * How far a drag moved the panel toward the edge it closes to: down for a sheet, left for the
 * drawer. A drag that is more across than along that direction is a scroll, not a swipe.
 */
export function swipeOffset(direction: 'down' | 'left', dx: number, dy: number): number {
  const along = direction === 'down' ? dy : -dx
  const across = direction === 'down' ? dx : dy
  if (along <= 0 || Math.abs(across) > along) return 0
  return along
}

/**
 * Lets a sheet be swiped down, or the drawer swiped left, to close, the panel following the finger.
 * Touch events, unlike pointer events, keep coming while the panel's own list scrolls; a sheet only
 * follows once its list is scrolled to the top.
 */
export function useSwipeToClose(
  panel: RefObject<HTMLElement | null>,
  direction: 'down' | 'left',
  onClose: () => void,
  enabled = true
): void {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const element = panel.current
    if (!element || !enabled) return
    let start: { x: number; y: number } | null = null
    let offset = 0
    const reset = (): void => {
      element.style.transform = ''
      element.style.transition = ''
      start = null
      offset = 0
    }
    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return
      if (direction === 'down' && element.scrollTop > 0) return
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    }
    const onMove = (event: TouchEvent): void => {
      if (!start) return
      const touch = event.touches[0]
      offset = swipeOffset(direction, touch.clientX - start.x, touch.clientY - start.y)
      if (!offset) {
        element.style.transform = ''
        return
      }
      if (event.cancelable) event.preventDefault()
      element.style.transition = 'none'
      element.style.transform =
        direction === 'down' ? `translateY(${offset}px)` : `translateX(${-offset}px)`
    }
    const onEnd = (): void => {
      if (!start) return
      const done = offset >= SWIPE_CLOSE_DISTANCE
      reset()
      if (done) close.current()
    }
    element.addEventListener('touchstart', onStart, { passive: true })
    element.addEventListener('touchmove', onMove, { passive: false })
    element.addEventListener('touchend', onEnd)
    element.addEventListener('touchcancel', reset)
    return () => {
      element.removeEventListener('touchstart', onStart)
      element.removeEventListener('touchmove', onMove)
      element.removeEventListener('touchend', onEnd)
      element.removeEventListener('touchcancel', reset)
      reset()
    }
  }, [panel, direction, enabled])
}
