// Custom hook for auto-focusing input elements

import { useEffect, RefObject } from 'react'

/**
 * Hook that automatically focuses an input element when conditions are met
 * Handles focus after conversation changes, loading completes, etc.
 *
 * @param inputRef - Ref to the input element to focus
 * @param isLoading - Whether content is currently loading
 * @param isEditing - Whether user is currently editing (skip focus if true)
 * @param conversationId - Current conversation ID (focus on change)
 * @param delay - Delay in ms before focusing (default: 150ms)
 *
 * @example
 * const inputRef = useRef<HTMLTextAreaElement>(null)
 * useAutoFocus(inputRef, isLoading, editingMessageId !== null, conversationId)
 */
export function useAutoFocus(
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  isLoading: boolean,
  isEditing: boolean,
  conversationId: string | null,
  delay: number = 150
): void {
  // Focus after conversation change or loading completes
  useEffect(() => {
    if (isLoading || isEditing) return

    const focusInput = (): void => {
      if (inputRef.current) {
        inputRef.current.focus()
      } else {
        // Retry if ref isn't ready
        window.setTimeout(focusInput, 100)
      }
    }

    const timeout = window.setTimeout(focusInput, delay)
    return () => window.clearTimeout(timeout)
  }, [conversationId, isLoading, isEditing, delay, inputRef])

  // Focus when window regains focus
  useEffect(() => {
    const handleWindowFocus = (): void => {
      if (!isLoading && !isEditing) {
        inputRef.current?.focus()
      }
    }

    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [isLoading, isEditing, inputRef])
}
