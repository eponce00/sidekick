// Drawn by scripts/generate-brand-assets.cjs from the same geometry as the app icon; its parts
// carry classes so the theme can colour them, the eyes can blink and look around, and the cape
// can move.
import { memo, useEffect, useRef, useState } from 'react'
import peekSvg from '../assets/sidekick-peek.svg?raw'
import {
  arrivingCape,
  capePose,
  capeSettled,
  gust,
  pointerWind,
  stepCape,
  whip,
  type CapeState
} from '../utils/capePhysics'
import { motionAllowed } from '../utils/messageMotion'
import './SidekickPeek.css'

// How far, in the drawing's units, the eyes move inside the visor, and the head turns, at most.
const EYE_TRAVEL = { x: 16, y: 10 }
const HEAD_TURN_DEG = 4
// A gust now and then, at a random interval and strength, so the cape never moves on a beat.
const GUST_EVERY_MS = { min: 7000, spread: 9000 }
// How close, in pixels, a quick pointer has to pass for the cape to feel its wind.
const POINTER_WIND_REACH = 420

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

  // The cape hangs under gravity and moves only when something moves it: the robot arriving, a
  // gust now and then, a quick pointer passing by, or a click. Between those it rests and the
  // loop sleeps.
  useEffect(() => {
    const element = ref.current
    const pivot = element?.querySelector<SVGGElement>('.peek-cape-rig')?.dataset.pivot
    if (!element || !pivot || !motionAllowed()) return undefined
    const [pivotX, pivotY] = pivot.split(' ').map(Number)
    let cape: CapeState = arrivingCape()
    let frame = 0
    let last = 0
    let gustTimer = 0
    const draw = (): void => {
      const rig = element.querySelector<SVGGElement>('.peek-cape-rig')
      const pose = capePose(cape)
      rig?.setAttribute(
        'transform',
        `translate(${pivotX} ${pivotY}) rotate(${pose.angle.toFixed(2)}) ` +
          `skewY(${pose.skew.toFixed(2)}) scale(${pose.stretch.toFixed(3)} 1) ` +
          `translate(${-pivotX} ${-pivotY})`
      )
    }
    const tick = (now: number): void => {
      // A long gap, such as a frame after the window was hidden, advances only one frame.
      const seconds = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
      last = now
      cape = stepCape(cape, seconds)
      draw()
      if (capeSettled(cape)) {
        frame = 0
        last = 0
        return
      }
      frame = window.requestAnimationFrame(tick)
    }
    const wake = (): void => {
      if (!frame) frame = window.requestAnimationFrame(tick)
    }
    const scheduleGust = (): void => {
      gustTimer = window.setTimeout(
        () => {
          if (motionAllowed()) {
            cape = gust(cape, 0.55 + Math.random() * 0.45)
            wake()
          }
          scheduleGust()
        },
        GUST_EVERY_MS.min + Math.random() * GUST_EVERY_MS.spread
      )
    }
    let previous: { x: number; y: number; at: number } | null = null
    const feelPointer = (event: PointerEvent): void => {
      const at = event.timeStamp
      const here = { x: event.clientX, y: event.clientY, at }
      const before = previous
      previous = here
      if (!before || at <= before.at || !motionAllowed()) return
      const box = element.getBoundingClientRect()
      const near = Math.hypot(
        here.x - (box.left + box.width / 2),
        here.y - (box.top + box.height / 2)
      )
      if (near > POINTER_WIND_REACH) return
      const wind = pointerWind(Math.hypot(here.x - before.x, here.y - before.y) / (at - before.at))
      if (wind > cape.wind) {
        cape = gust(cape, wind)
        wake()
      }
    }
    flick.current = () => {
      cape = whip(cape)
      wake()
    }
    window.addEventListener('pointermove', feelPointer)
    wake()
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
