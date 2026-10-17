const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
const LEAVE_MS = 340
const LEAVE_STAGGER_MS = 35

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * A section opening or closing under the reader's hand. The chat holds its scroll for `detail.ms`
 * instead of following the bottom, so the section unfolds from where it was clicked.
 */
export const SECTION_REVEAL_EVENT = 'sidekick:section-reveal'

/** Motion only where someone can see it: a hidden window does not advance animations. */
export function motionAllowed(): boolean {
  return document.visibilityState !== 'hidden' && !prefersReducedMotion()
}

function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return Boolean(element && typeof (element as HTMLElement).animate === 'function')
}

/** A message just sent rises into the chat out of the message box below it. */
export function riseIntoChat(element: HTMLElement | null | undefined): void {
  if (!canAnimate(element) || !motionAllowed()) return
  element.animate(
    [
      { transform: 'translateY(32px) scale(0.98)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ],
    { duration: 420, easing: EASE_OUT }
  )
}

/** A reply eases in just after the message it answers. */
export function easeInReply(element: HTMLElement | null | undefined): void {
  if (!canAnimate(element) || !motionAllowed()) return
  element.animate(
    [
      { transform: 'translateY(10px)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ],
    { duration: 360, delay: 90, easing: EASE_OUT, fill: 'backwards' }
  )
}

/**
 * Messages a rewind replaces drift down and dissolve where they stand, one after another, before
 * they leave the chat. Resolves once they are gone from view; the ones off screen just hide.
 */
export function dissolveMessages(elements: HTMLElement[], viewport: DOMRect | null): Promise<void> {
  if (!elements.length || !motionAllowed()) return Promise.resolve()
  const animations: Animation[] = []
  let visibleIndex = 0
  for (const element of elements) {
    if (!canAnimate(element)) continue
    const rect = element.getBoundingClientRect()
    const onScreen =
      !viewport || (rect.bottom > viewport.top && rect.top < viewport.bottom && rect.height > 0)
    if (!onScreen) {
      element.style.visibility = 'hidden'
      continue
    }
    // A message already stepped back while being edited starts from where it is.
    const style = getComputedStyle(element)
    const filter = style.filter === 'none' ? 'blur(0px)' : style.filter
    animations.push(
      element.animate(
        [
          { transform: 'none', opacity: style.opacity, filter },
          { transform: 'translateY(16px) scale(0.985)', opacity: 0, filter: 'blur(6px)' }
        ],
        {
          duration: LEAVE_MS,
          delay: Math.min(visibleIndex, 5) * LEAVE_STAGGER_MS,
          easing: 'cubic-bezier(0.4, 0, 1, 1)',
          fill: 'forwards'
        }
      )
    )
    visibleIndex += 1
  }
  const finished = Promise.all(
    animations.map((animation) => animation.finished.catch(() => undefined))
  ).then(() => undefined)
  // The chat moves on when they would have finished, even if the window was hidden meanwhile
  // and they stopped.
  const longest = LEAVE_MS + Math.min(visibleIndex, 5) * LEAVE_STAGGER_MS + 60
  return Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, longest))])
}

/** The send arrow lifts off and a fresh one settles back in. */
export function liftSendArrow(icon: Element | null | undefined): void {
  if (!canAnimate(icon) || !motionAllowed()) return
  icon.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: 'translateY(-14px)', opacity: 0, offset: 0.4 },
      { transform: 'translateY(12px)', opacity: 0, offset: 0.41 },
      { transform: 'none', opacity: 1 }
    ],
    { duration: 520, easing: EASE_OUT }
  )
}
