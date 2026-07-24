// Custom hook for managing outside click detection (closing menus/dropdowns)

import { useEffect, RefObject } from 'react'

/**
 * Hook that triggers a callback when user clicks outside specified elements
 * Useful for closing dropdowns, menus, modals, etc.
 *
 * @param refs - Array of refs to elements that should NOT trigger the callback when clicked
 * @param callback - Function to call when clicking outside all refs
 * @param isActive - Whether the hook should be active (default: true)
 *
 * @example
 * const menuRef = useRef<HTMLDivElement>(null)
 * const buttonRef = useRef<HTMLButtonElement>(null)
 * useOutsideClick([menuRef, buttonRef], () => setIsOpen(false), isOpen)
 */
export function useOutsideClick(
  refs: RefObject<HTMLElement | null>[],
  callback: () => void,
  isActive: boolean = true
): void {
  useEffect(() => {
    if (!isActive) return

    const handleClickOutside = (event: MouseEvent): void => {
      const clickedOutsideAll = refs.every(
        (ref) => ref.current && !ref.current.contains(event.target as Node)
      )

      if (clickedOutsideAll) {
        callback()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [refs, callback, isActive])
}
