import { flushSync } from 'react-dom'
import { prefersReducedMotion } from './messageMotion'

/**
 * Switches the theme as a circle spreading from `origin` (the button pressed), the new colors
 * revealed over the old. `apply` changes the theme; it runs inside the transition, flushed at
 * once, so the new look is what gets revealed. Without view transitions or with reduced motion,
 * the theme just changes.
 */
export function switchThemeFrom(origin: Element | null | undefined, apply: () => void): void {
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    apply()
    return
  }
  const rect = origin?.getBoundingClientRect()
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
  const y = rect ? rect.top + rect.height / 2 : 0
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  const root = document.documentElement
  // Colors change all at once under the circle rather than each fading on its own.
  root.classList.add('theme-switching')
  const transition = document.startViewTransition(() => flushSync(apply))
  transition.ready
    .then(() =>
      root.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
        },
        {
          duration: 560,
          easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      )
    )
    .catch(() => undefined)
  void transition.finished.finally(() => root.classList.remove('theme-switching'))
}
