import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * A footer item that opens a floating card above itself. The card points at the item that opened
 * it, stays inside the message, and closes on a click elsewhere or Escape, which also closes one
 * footer card when another opens.
 */
export function MessageFooterPopover({
  className,
  cardClassName,
  title,
  label,
  children
}: {
  className: string
  cardClassName: string
  title: string
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => {
      if (detailsRef.current) detailsRef.current.open = false
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!detailsRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Opens from the item's left edge, shifted left only as far as the message's right edge needs.
  useLayoutEffect(() => {
    const details = detailsRef.current
    const card = cardRef.current
    if (!open || !details || !card) return
    const bounds = (details.closest('.message') ?? document.body).getBoundingClientRect()
    const anchor = details.getBoundingClientRect()
    const overflow = anchor.left + card.offsetWidth - bounds.right
    const shift = overflow > 0 ? Math.min(overflow, Math.max(0, anchor.left - bounds.left)) : 0
    card.style.setProperty('--footer-popover-shift', `${-shift}px`)
  }, [open])

  return (
    <details
      ref={detailsRef}
      className={`message-footer-popover ${className}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={title}>
        {label}
        <ChevronDown size={10} aria-hidden="true" />
      </summary>
      <div ref={cardRef} className={`message-footer-popover-card ${cardClassName}`}>
        {children}
      </div>
    </details>
  )
}
