// Drawn by scripts/generate-brand-assets.cjs from the same geometry as the app icon; its parts
// carry classes so the theme can colour them, the eyes can blink and look around, and the cape
// can move.
import { memo, useEffect, useRef, useState } from 'react'
import peekSvg from '../assets/sidekick-peek.svg?raw'
import { CapeCloth } from '../utils/capeCloth'
import { motionAllowed, prefersReducedMotion } from '../utils/messageMotion'
import './SidekickPeek.css'

// How far, in the drawing's units, the eyes move inside the visor, and the head turns, at most.
const EYE_TRAVEL = { x: 16, y: 10 }
const HEAD_TURN_DEG = 4
// A gust now and then, at a random interval and strength, so the cape never moves on a beat.
const GUST_EVERY_MS = { min: 6000, spread: 9000 }
// Gusts build over a fraction of a second and die away over a couple, as real ones do.
const GUST_RISE_PER_SECOND = 5
const GUST_FALL_PER_SECOND = 0.9
// A quick pointer passing near makes wind, from this speed in pixels per millisecond.
const POINTER_WIND_REACH = 420
const POINTER_WIND_FROM = 0.5

type Reaction = 'wink' | 'happy'

/** The drawing, kept out of the button's re-renders so the cape's pose is never reset under it. */
const Drawing = memo(function Drawing() {
  return <span className="sidekick-peek-drawing" dangerouslySetInnerHTML={{ __html: peekSvg }} />
})

/** SideKick's robot, leaning out from behind the side panel into an empty chat. */
export function SidekickPeek(): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const pokes = useRef(0)
  const flick = useRef<() => void>(() => undefined)
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

  // The cape is cloth (capeCloth): it hangs under gravity, sways in a light breeze, streams back
  // in a gust now and then, gives way where the pointer brushes through it, and flicks up on a
  // click. Each frame redraws its outline from the simulation. With reduced motion it stays as
  // drawn.
  useEffect(() => {
    const element = ref.current
    const cape = element?.querySelector<SVGPathElement>('.peek-cape')
    const lining = element?.querySelector<SVGPathElement>('.peek-cape-lining')
    // Only reduced motion stops it for good. A hidden window just pauses it: the browser holds
    // animation frames back until the window is seen again, so the robot can appear while SideKick
    // is in the tray and its cape still moves once it is shown.
    if (!element || !cape || !lining || prefersReducedMotion()) return undefined
    const cloth = new CapeCloth()
    let wind = 0
    let gustTarget = 0
    let frame = 0
    let last = 0
    let gustTimer = 0
    const tick = (now: number): void => {
      const seconds = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
      last = now
      wind += (gustTarget - wind) * Math.min(1, seconds * GUST_RISE_PER_SECOND)
      gustTarget *= Math.exp(-GUST_FALL_PER_SECOND * seconds)
      cloth.step(seconds, wind)
      const paths = cloth.paths()
      cape.setAttribute('d', paths.cape)
      lining.setAttribute('d', paths.lining)
      frame = window.requestAnimationFrame(tick)
    }
    const gust = (strength: number): void => {
      gustTarget = Math.max(gustTarget, Math.min(1, strength))
    }
    const scheduleGust = (): void => {
      gustTimer = window.setTimeout(
        () => {
          if (motionAllowed()) gust(0.55 + Math.random() * 0.45)
          scheduleGust()
        },
        GUST_EVERY_MS.min + Math.random() * GUST_EVERY_MS.spread
      )
    }
    // The pointer in the cape's own units, and how fast it moves there.
    let previous: { x: number; y: number; at: number; screenX: number; screenY: number } | null =
      null
    const feelPointer = (event: PointerEvent): void => {
      const matrix = cape.getScreenCTM?.()
      if (!matrix || !motionAllowed()) return
      const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
      const here = {
        x: local.x,
        y: local.y,
        at: event.timeStamp,
        screenX: event.clientX,
        screenY: event.clientY
      }
      const before = previous
      previous = here
      if (!before || here.at <= before.at) return
      const seconds = (here.at - before.at) / 1000
      cloth.brush(here, { x: (here.x - before.x) / seconds, y: (here.y - before.y) / seconds })
      const box = element.getBoundingClientRect()
      const near = Math.hypot(
        here.screenX - (box.left + box.width / 2),
        here.screenY - (box.top + box.height / 3)
      )
      const speed =
        Math.hypot(here.screenX - before.screenX, here.screenY - before.screenY) /
        (here.at - before.at)
      if (near < POINTER_WIND_REACH && speed > POINTER_WIND_FROM)
        gust((speed - POINTER_WIND_FROM) * 0.4)
    }
    flick.current = () => {
      cloth.flick()
      gust(0.4)
    }
    window.addEventListener('pointermove', feelPointer)
    frame = window.requestAnimationFrame(tick)
    scheduleGust()
    return () => {
      window.removeEventListener('pointermove', feelPointer)
      window.cancelAnimationFrame(frame)
      window.clearTimeout(gustTimer)
      flick.current = () => undefined
    }
  }, [])

  const poke = (): void => {
    flick.current()
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
    >
      <Drawing />
    </button>
  )
}
