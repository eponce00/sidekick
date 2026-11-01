import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true'
  )
}

/**
 * Traps focus in a modal dialog. `alsoFocusable` names controls outside it that stay usable while
 * it is open (Settings leaves the title bar's actions showing); Tab cycles through those first.
 */
export function useModalDialog<T extends HTMLElement>(
  isOpen: boolean,
  onClose: () => void,
  alsoFocusable?: string
): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog || dialog.contains(document.activeElement)) return
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]')
      ;(preferred || focusableElements(dialog)[0] || dialog).focus()
    })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const outside = alsoFocusable
        ? Array.from(document.querySelectorAll<HTMLElement>(alsoFocusable)).flatMap((element) =>
            focusableElements(element).filter((item) => !dialog.contains(item))
          )
        : []
      const inside = focusableElements(dialog)
      const focusable = [...outside, ...inside]
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      if (current === -1) {
        event.preventDefault()
        ;(event.shiftKey ? focusable.at(-1)! : focusable[0]).focus()
        return
      }
      const next =
        focusable[(current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]
      // Within one group the browser's own order holds; across groups, and at the ends, the
      // cycle moves focus itself, since the two groups need not be neighbours in the page.
      const sameGroup = (a: HTMLElement, b: HTMLElement): boolean =>
        inside.includes(a) === inside.includes(b)
      const wraps = event.shiftKey ? current === 0 : current === focusable.length - 1
      if (wraps || !sameGroup(focusable[current], next)) {
        event.preventDefault()
        next.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [isOpen, alsoFocusable])

  return dialogRef
}
