// Drawn by scripts/generate-brand-assets.cjs from the same geometry as the app icon; its parts
// carry classes so the theme can colour them and the eyes can blink and look around.
import { useEffect, useRef, useState } from 'react'
import peekSvg from '../assets/sidekick-peek.svg?raw'
import { motionAllowed } from '../utils/messageMotion'
import './SidekickPeek.css'

// How far, in the drawing's units, the eyes move inside the visor, and the head turns, at most.
const EYE_TRAVEL = { x: 16, y: 10 }
const HEAD_TURN_DEG = 4

type Reaction = 'wink' | 'happy'

/** SideKick's robot, leaning out from behind the side panel into an empty chat. */
export function SidekickPeek(): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const pokes = useRef(0)
  const [reaction, setReaction] = useState<Reaction | null>(null)

  // Its eyes follow the pointer, and its head leans a little toward it.
  useEffect(() => {
    let frame = 0
    let pointer: { x: number; y: number } | null = null
    const look = (): void => {
      frame = 0
      const element = ref.current
      if (!element || !pointer) return
      const box = element.getBoundingClientRect()
      const dx = pointer.x - (box.left + box.width * 0.45)
      const dy = pointer.y - (box.top + box.height * 0.5)
      const distance = Math.hypot(dx, dy) || 1
      // Close to it the eyes move little; across the window they reach the visor's edge.
      const reach = Math.min(1, distance / 320)
      element.style.setProperty(
        '--look-x',
        `${((dx / distance) * reach * EYE_TRAVEL.x).toFixed(1)}px`
      )
      element.style.setProperty(
        '--look-y',
        `${((dy / distance) * reach * EYE_TRAVEL.y).toFixed(1)}px`
      )
      // The head pivots where it meets the panel's edge, to the right of its face, so turning it
      // counter-clockwise is what dips the face toward a pointer below it.
      element.style.setProperty(
        '--head-turn',
        `${((-dy / distance) * reach * HEAD_TURN_DEG).toFixed(2)}deg`
      )
    }
    const move = (event: PointerEvent): void => {
      if (!motionAllowed()) return
      pointer = { x: event.clientX, y: event.clientY }
      if (!frame) frame = window.requestAnimationFrame(look)
    }
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointermove', move)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  const poke = (): void => {
    pokes.current += 1
    // A hop and a wink; every third poke it squints happily instead. Clearing first restarts the
    // reaction when it is poked again mid-hop.
    const next: Reaction = pokes.current % 3 === 0 ? 'happy' : 'wink'
    setReaction(null)
    window.requestAnimationFrame(() => setReaction(next))
  }

  useEffect(() => {
    if (!reaction) return undefined
    const timer = window.setTimeout(() => setReaction(null), 900)
    return () => window.clearTimeout(timer)
  }, [reaction])

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className={`sidekick-peek${reaction ? ` is-${reaction}` : ''}`}
      onClick={poke}
      dangerouslySetInnerHTML={{ __html: peekSvg }}
    />
  )
}
