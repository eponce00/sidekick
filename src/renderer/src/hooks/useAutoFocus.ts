// Custom hook for auto-focusing input elements

import { useEffect, RefObject } from 'react'

/**
 * An open modal owns the keyboard. Taking focus back would send what the user types there, such
 * as an API key in Settings, into the chat composer instead.
 */
function modalIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/**
 * Nor does a field the user is typing in elsewhere, such as the browser's address bar or the
 * terminal. The chat changing or a reply finishing would otherwise move the rest of what they
 * type into the composer.
 */
function typingElsewhere(input: HTMLElement | null): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === input || active.closest('[hidden]')) {
    return false
  }
  if (active instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(active.type)
  return (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    active.isContentEditable
  )
}

function keyboardTaken(input: HTMLElement | null): boolean {
  return modalIsOpen() || typingElsewhere(input)
}

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
      if (keyboardTaken(inputRef.current)) return
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
      if (!isLoading && !isEditing && !keyboardTaken(inputRef.current)) {
        inputRef.current?.focus()
      }
    }

    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [isLoading, isEditing, inputRef])
}
