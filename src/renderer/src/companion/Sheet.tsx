import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

/** A panel that rises from the bottom of the screen, within reach of the thumb. */
export function Sheet({
  label,
  onClose,
  children
}: {
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus({ preventScroll: true })
    }
  }, [onClose])
  return createPortal(
    <div
      className="cp-sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        className="cp-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <span className="cp-sheet-handle" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body
  )
}

export function SheetSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="cp-sheet-section" role="group" aria-label={label}>
      <div className="cp-sheet-section-label">{label}</div>
      {children}
    </section>
  )
}

/** One choice in a sheet, as the desktop's add menu shows them: icon, name, what it does. */
export function SheetAction({
  icon,
  label,
  description,
  selected,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  description?: string
  selected?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`cp-sheet-action${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
    >
      <span className="cp-sheet-action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="cp-sheet-action-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {selected && <Check size={16} className="cp-sheet-action-check" aria-hidden="true" />}
    </button>
  )
}
