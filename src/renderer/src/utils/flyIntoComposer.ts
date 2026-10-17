const GLIDE_MS = 440
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * Shows a message moving from the chat into the message box: a copy of its bubble glides and
 * shrinks to where the text lands, fading as the box takes it, and the box's text fades in. Only
 * transform and opacity animate, so it stays smooth on a long chat. Reduced motion skips it.
 */
export function flyIntoComposer(source: HTMLElement | null, composer: HTMLElement | null): void {
  if (!source || !composer || typeof source.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const text = composer.querySelector('textarea')
  const from = source.getBoundingClientRect()
  const to = (text ?? composer).getBoundingClientRect()
  if (!from.width || !from.height || !to.width) return

  const ghost = source.cloneNode(true) as HTMLElement
  ghost.classList.add('message-edit-ghost')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    zIndex: '9000',
    pointerEvents: 'none',
    transformOrigin: 'top left'
  })
  document.body.appendChild(ghost)

  // The bubble settles over the box, its text on the box's first line of text.
  const box = composer.getBoundingClientRect()
  const inset = (element: Element, side: 'Left' | 'Top'): number =>
    parseFloat(getComputedStyle(element)[`padding${side}`]) || 0
  const scale = Math.min(1, Math.max(0.4, box.width / from.width))
  const textLeft = to.left + (text ? inset(text, 'Left') : 0)
  const textTop = to.top + (text ? inset(text, 'Top') : 0)
  const dx = textLeft - inset(source, 'Left') * scale - from.left
  const dy = textTop - inset(source, 'Top') * scale - from.top
  const glide = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { opacity: 0.9, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 }
    ],
    { duration: GLIDE_MS, easing: EASE_OUT }
  )
  const cleanUp = (): void => ghost.remove()
  glide.onfinish = cleanUp
  glide.oncancel = cleanUp

  text?.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 260,
    delay: GLIDE_MS * 0.55,
    easing: 'ease-out',
    fill: 'backwards'
  })
  composer.animate(
    [
      { boxShadow: '0 0 0 0 transparent' },
      { boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent)', offset: 0.4 },
      { boxShadow: '0 0 0 0 transparent' }
    ],
    { duration: 700, delay: GLIDE_MS * 0.5, easing: 'ease-out' }
  )
}
