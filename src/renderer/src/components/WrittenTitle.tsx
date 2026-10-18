import { useLayoutEffect, useRef } from 'react'
import { motionAllowed } from '../utils/messageMotion'

/**
 * A chat's title that writes itself in, left to right, when it changes: a new chat getting its
 * name, or a rename. Showing another chat's title (`identity` changes) just shows it.
 */
export function WrittenTitle({
  text,
  identity,
  className
}: {
  text: string
  identity: string | null | undefined
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const previous = useRef({ text, identity })

  useLayoutEffect(() => {
    const was = previous.current
    previous.current = { text, identity }
    const element = ref.current
    if (was.identity !== identity || was.text === text || !element) return
    if (typeof element.animate !== 'function' || !motionAllowed()) return
    // A soft edge sweeps across, uncovering the words as if typed.
    const mask = 'linear-gradient(90deg, #000 45%, transparent 55%)'
    element.animate(
      [
        { maskImage: mask, maskSize: '240% 100%', maskPosition: '100% 0' },
        { maskImage: mask, maskSize: '240% 100%', maskPosition: '0% 0' }
      ],
      { duration: Math.min(1100, 320 + text.length * 22), easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
    )
  }, [identity, text])

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  )
}
