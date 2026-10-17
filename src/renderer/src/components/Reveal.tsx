import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motionAllowed } from '../utils/messageMotion'

const REVEAL_MS = 260
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

function canAnimate(): boolean {
  return typeof Element.prototype.animate === 'function' && motionAllowed()
}

/**
 * Content that slides open and closed instead of appearing at once. It stays mounted while it
 * closes, then leaves. Already open on first render, it just shows.
 */
export function Reveal({
  open,
  children
}: {
  open: boolean
  children: ReactNode
}): React.JSX.Element | null {
  const [shown, setShown] = useState(open)
  if (open && !shown) setShown(true)
  // Without motion, closing removes it at once.
  if (!open && shown && !canAnimate()) setShown(false)
  const ref = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(open)
  const running = useRef<Animation | null>(null)

  useLayoutEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    const element = ref.current
    if (!element || !canAnimate()) return
    // Reversing midway starts from where it got to; opening starts from nothing, though the
    // content has just mounted at its full height.
    const from = running.current || !open ? element.getBoundingClientRect().height : 0
    running.current?.cancel()
    const to = open ? element.scrollHeight : 0
    const animation = element.animate(
      [
        { height: `${from}px`, opacity: open ? 0 : 1, overflow: 'clip' },
        { height: `${to}px`, opacity: open ? 1 : 0, overflow: 'clip' }
      ],
      // Closed, it stays shut until it has left.
      { duration: REVEAL_MS, easing: EASE_OUT, fill: open ? 'none' : 'forwards' }
    )
    running.current = animation
    animation.onfinish = () => {
      running.current = null
      if (!open) setShown(false)
    }
  }, [open])

  if (!shown) return null
  return (
    <div ref={ref} className="reveal">
      {children}
    </div>
  )
}
